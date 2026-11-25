/*
 * pka_native.c - servidor do canal nativo do PokeAlliance, injetado no jogo.
 *
 * Substitui o papel da DLL do fornecedor: cria o named pipe
 * \\.\pipe\pka-runtime-2-<pid>, faz o handshake HMAC-SHA256 (PKA2) e publica
 * state/telemetry lendo a memoria do proprio processo.
 *
 * Contrato reconstruido (reconstruction/framing.cjs, protocol.cjs, telemetry.cjs,
 * transport.cjs):
 *   quadro      [u32 len][u32 kind][payload]
 *   kinds       1 challenge 2 authenticate 3 welcome 4 state 5 telemetry
 *               8 automation_revoked 9 manual 10 ack
 *   challenge   nonce 16..64 bytes (aqui 32)
 *   authenticate HMAC-SHA256(chave, "PKA2/client\0" + nonce + u32le(pid))
 *   welcome     u32le(pid) + HMAC-SHA256(chave, "PKA2/server\0" + nonce + u32le(pid))
 *   state       48 bytes
 *   ack         12 bytes: id, tipo, status
 *
 * Chave: PKA_CHANNEL_KEY do ambiente do processo; fallback para o arquivo
 * indicado em PKA_CHANNEL_KEY_FILE. Sem chave a DLL nao cria o pipe.
 *
 * Modo host (para prova local): defina PKA_HOST_MODE=1 e PKA_CHANNEL_PID=<n>
 * para servir um pipe com PID falso, sem precisar estar dentro do jogo.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>
#include <psapi.h>

#pragma comment(lib, "bcrypt.lib")

/* --------------------------------------------------- nome do modulo e PEB
 * O anticheat do cliente enumera modulos carregados. Guardamos a pasta no
 * init e, depois de tudo pronto, desligamos a entrada da DLL das listas do
 * PEB: ela continua mapeada e funcional, mas some de EnumProcessModules. */
static char g_moduleDir[MAX_PATH];
static HMODULE g_selfModule;

typedef struct { USHORT Length, MaximumLength; PWSTR Buffer; } uni_string_t;
typedef struct { ULONG Length; BOOLEAN Initialized; PVOID SsHandle;
    LIST_ENTRY InLoadOrderModuleList; LIST_ENTRY InMemoryOrderModuleList;
    LIST_ENTRY InInitializationOrderModuleList; } peb_ldr_t;
typedef struct { BYTE pad[0x18]; peb_ldr_t *Ldr; } peb_t;
typedef struct { LIST_ENTRY InLoadOrderLinks; LIST_ENTRY InMemoryOrderLinks;
    LIST_ENTRY InInitializationOrderLinks; PVOID DllBase; } ldr_entry_t;

static void cache_module_dir(HINSTANCE inst)
{
    DWORD n = GetModuleFileNameA(inst, g_moduleDir, (DWORD)sizeof g_moduleDir);
    if (!n || n >= sizeof g_moduleDir) { g_moduleDir[0] = 0; return; }
    char *slash = strrchr(g_moduleDir, '\\');
    if (slash) *(slash + 1) = 0;
}

static int module_file(char *out, size_t cap, const char *name)
{
    if (!g_moduleDir[0]) return 0;
    snprintf(out, cap, "%s%s", g_moduleDir, name);
    return 1;
}

static void unlink_one(LIST_ENTRY *link)
{
    link->Flink->Blink = link->Blink;
    link->Blink->Flink = link->Flink;
}

static void hide_self(HMODULE self)
{
    if (!self) return;
    peb_t *peb = (peb_t *)__readgsqword(0x60);
    if (!peb || !peb->Ldr) return;
    LIST_ENTRY *load = &peb->Ldr->InLoadOrderModuleList;
    for (LIST_ENTRY *it = load->Flink; it != load; it = it->Flink) {
        ldr_entry_t *entry = (ldr_entry_t *)it;
        if ((HMODULE)entry->DllBase != self) continue;
        unlink_one(&entry->InLoadOrderLinks);
        unlink_one(&entry->InMemoryOrderLinks);
        unlink_one(&entry->InInitializationOrderLinks);
        return;
    }
}


#define MAX_FRAME 2105344u
#define NONCE_SIZE 32
#define PIPE_BUFFER 65536
#define STATE_INTERVAL_MS 100
#define TELEMETRY_INTERVAL_MS 1000
#define AUTOMATION_INTERVAL_MS 500
#define SCAN_INTERVAL_MS 8000

/* Cadencia do canal de OBSERVACAO (kind 5 completo, com position).
 *
 * WHY SEPARAR: TELEMETRY_INTERVAL_MS=1000 e' o ritmo do fornecedor e nao deve
 * mudar — e' o que o menu espera. Mas para medir se `holding` acompanha a
 * parada fisica do personagem precisamos de resolucao melhor que a duracao de
 * uma parada curta (~300 ms). A 1 Hz, uma parada de 300 ms cai inteira entre
 * duas amostras e vira invisivel.
 *
 * O modo e' ligado por arquivo ao lado da DLL (mesmo padrao de
 * pka_player_name.txt / pka_attack_fire.txt: processo vivo nao herda ambiente):
 *
 *     native/pka_observe_hz.txt  ->  conteudo "20" (1..50)
 *
 * Sem o arquivo, a cadencia continua 1000 ms. Com ele, o kind 5 e' publicado
 * no intervalo pedido APENAS quando nao ha outro envio iminente, para nao
 * saturar o pipe.
 *
 * Custo medido em 2026-11-11: build_telemetry varre a lista de criaturas ja'
 * escaneada (nao faz scan); a 20 Hz o custo e' desprezivel comparado ao scan
 * de 8 s. */
#define OBSERVE_MIN_HZ 1
#define OBSERVE_MAX_HZ 50

#define KIND_CHALLENGE 1
#define KIND_AUTHENTICATE 2
#define KIND_WELCOME 3
#define KIND_STATE 4
#define KIND_TELEMETRY 5
#define KIND_AUTOMATION 6
#define KIND_AUTOMATION_REVOKED 8
#define KIND_MANUAL 9
#define KIND_ACK 10
#define KIND_AUTOMATION_CONTROL 11
#define KIND_AUTOMATION_LEASE 12

#define PIPE_ACCESS_DUPLEX 0x00000003
#define PIPE_TYPE_BYTE 0x00000000
#define PIPE_READMODE_BYTE 0x00000000
#define PIPE_WAIT_MODE 0x00000000
#define PIPE_UNLIMITED_INSTANCES 255

/* ------------------------------------------------------------------ log */
static CRITICAL_SECTION g_logLock;
static int g_logReady = 0;
static char g_logPath[MAX_PATH];
static FILE *g_logFile = NULL;

static void log_open(void)
{
    if (g_logReady) return;
    InitializeCriticalSection(&g_logLock);
    g_logReady = 1;
    const char *dir = getenv("PKA_LOG_DIR");
    if (dir && *dir) {
        snprintf(g_logPath, sizeof g_logPath, "%s\\pka_native.log", dir);
        g_logFile = fopen(g_logPath, "a");
    }
    if (!g_logFile) {
        char tmp[MAX_PATH];
        DWORD n = GetTempPathA((DWORD)sizeof tmp, tmp);
        if (n > 0 && n < sizeof tmp) {
            snprintf(g_logPath, sizeof g_logPath, "%spka_native.log", tmp);
            g_logFile = fopen(g_logPath, "a");
        }
    }
}

static void log_line(const char *fmt, ...)
{
    log_open();
    EnterCriticalSection(&g_logLock);
    char stamp[32];
    SYSTEMTIME st;
    GetLocalTime(&st);
    snprintf(stamp, sizeof stamp, "%02d:%02d:%02d.%03d ",
             st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    if (g_logFile) {
        fputs(stamp, g_logFile);
        va_list ap;
        va_start(ap, fmt);
        vfprintf(g_logFile, fmt, ap);
        va_end(ap);
        fputc('\n', g_logFile);
        fflush(g_logFile);
    }
    LeaveCriticalSection(&g_logLock);
}

/* --------------------------------------------------------- caminho do pipe */
static int32_t g_targetPid = 0;
static char g_pipeName[128];
static uint8_t g_key[256];
static size_t g_keyLen = 0;

/* Desligamento limpo. Sem isso, FreeLibrary() (pka_uninject.exe) descarrega o
 * codigo com as threads ainda rodando -> crash do jogo. Visto em 2026-11-09. */
static volatile LONG g_stop = 0;
static HANDLE g_threads[8];
static int g_threadCount = 0;
static HANDLE g_pipeHandle = INVALID_HANDLE_VALUE;

/* Handle de evento que ACORDA as threads imediatamente no shutdown.
 * Sem ele, scanner_thread dorme SCAN_INTERVAL_MS (8 s) e server_thread fica
 * preso em ConnectNamedPipe sem timeout: shutdown_clean espera 3 s, desiste e
 * libera o codigo com as threads vivas -> 0xC0000005. Visto em 2026-11-09. */
static HANDLE g_stopEvent = NULL;

/* handle de "acorda o scanner": disparado quando a sessao precisa de lista
 * de criaturas fresca (handshake). Reaproveita o padrao de sleep_or_stop. */
static HANDLE g_scanWakeEvent = NULL;

static int stop_signaled(void)
{
    return g_stop != 0 ||
           (g_stopEvent && WaitForSingleObject(g_stopEvent, 0) == WAIT_OBJECT_0);
}

/* espera ms ou acorda antes se o shutdown for sinalizado */
static void sleep_or_stop(DWORD ms)
{
    if (g_stopEvent) WaitForSingleObject(g_stopEvent, ms);
    else Sleep(ms);
}

static int32_t current_pid(void)
{
    const char *host = getenv("PKA_HOST_MODE");
    if (host && host[0] == '1') {
        const char *fake = getenv("PKA_CHANNEL_PID");
        if (fake) return (int32_t)strtol(fake, NULL, 10);
    }
    return (int32_t)GetCurrentProcessId();
}

/* ------------------------------------------------------------------ chave */
/* Ordem de busca:
 *   1. PKA_CHANNEL_KEY no ambiente
 *   2. PKA_CHANNEL_KEY_FILE
 *   3. pka_channel_key.txt ao lado da DLL  <- usado na injecao, porque o alvo
 *      nao herda o ambiente de quem injeta
 *   4. %TEMP%\pka_channel_key.txt
 */
static void strip_key(char *buf)
{
    const char *p = strstr(buf, "\"key\"");
    if (p) {
        p = strchr(p + 5, '"');
        if (p) {
            p++;
            const char *end = strchr(p, '"');
            if (end && (size_t)(end - p) <= sizeof g_key) {
                memcpy(g_key, p, (size_t)(end - p));
                g_keyLen = (size_t)(end - p);
            }
        }
        return;
    }
    size_t len = strlen(buf);
    while (len && (buf[len - 1] == '\n' || buf[len - 1] == '\r' || buf[len - 1] == ' '))
        buf[--len] = 0;
    if (len && len <= sizeof g_key) {
        memcpy(g_key, buf, len);
        g_keyLen = len;
    }
}

static int key_from_file(const char *path)
{
    if (!path || !*path) return 0;
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    long size = 0;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return 0; }
    size = ftell(f);
    if (size <= 0 || size > 4096 || fseek(f, 0, SEEK_SET) != 0) { fclose(f); return 0; }
    char *buf = (char *)malloc((size_t)size + 1);
    if (!buf) { fclose(f); return 0; }
    size_t got = fread(buf, 1, (size_t)size, f);
    buf[got] = 0;
    strip_key(buf);
    free(buf);
    fclose(f);
    return g_keyLen > 0;
}

static int key_load(void)
{
    const char *env = getenv("PKA_CHANNEL_KEY");
    if (env && *env) {
        size_t n = strlen(env);
        if (n > sizeof g_key) n = sizeof g_key;
        memcpy(g_key, env, n);
        g_keyLen = n;
        log_line("chave lida do ambiente (%zu bytes)", n);
        return 1;
    }

    if (key_from_file(getenv("PKA_CHANNEL_KEY_FILE"))) {
        log_line("chave lida de PKA_CHANNEL_KEY_FILE (%zu bytes)", g_keyLen);
        return 1;
    }

    /* ao lado da DLL (pasta cacheada: a DLL some do PEB depois) */
    {
        char candidate[MAX_PATH];
        if (module_file(candidate, sizeof candidate, "pka_channel_key.txt")
            && key_from_file(candidate)) {
            log_line("chave lida de %s (%zu bytes)", candidate, g_keyLen);
            return 1;
        }
    }

    char tmp[MAX_PATH];
    DWORD m = GetTempPathA((DWORD)sizeof tmp, tmp);
    if (m > 0 && m < sizeof tmp) {
        char candidate[MAX_PATH];
        snprintf(candidate, sizeof candidate, "%spka_channel_key.txt", tmp);
        if (key_from_file(candidate)) {
            log_line("chave lida de %s (%zu bytes)", candidate, g_keyLen);
            return 1;
        }
    }

    log_line("ERRO: sem chave (ambiente, arquivo ao lado da DLL, %%TEMP%%)");
    return 0;
}

/* ------------------------------------------------------------------ HMAC */
static int hmac_sha256(const uint8_t *key, size_t keyLen,
                       const uint8_t *data, size_t dataLen, uint8_t out[32])
{
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    NTSTATUS status;
    int ok = 0;

    status = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL,
                                         BCRYPT_ALG_HANDLE_HMAC_FLAG);
    if (status < 0) return 0;

    status = BCryptCreateHash(alg, &hash, NULL, 0, (PUCHAR)key, (ULONG)keyLen, 0);
    if (status >= 0) {
        status = BCryptHashData(hash, (PUCHAR)data, (ULONG)dataLen, 0);
        if (status >= 0) {
            status = BCryptFinishHash(hash, out, 32, 0);
            if (status >= 0) ok = 1;
        }
        BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}

/* proof = HMAC(key, dominio + nonce + u32le(pid))
 * O dominio inclui o NUL final: "PKA2/client" tem 11 chars + 1 NUL = 12 bytes,
 * igual ao Buffer.from('PKA2/client\0') do cliente. strlen() pararia em 11. */
static const char DOMAIN_CLIENT[] = "PKA2/client\0";
static const char DOMAIN_SERVER[] = "PKA2/server\0";
#define DOMAIN_LEN (sizeof DOMAIN_CLIENT - 1)

static int make_proof(const char *domain, size_t domLen, const uint8_t *nonce, size_t nonceLen,
                      int32_t pid, uint8_t out[32])
{
    uint8_t buf[32 + 64 + 4];
    if (domLen + nonceLen + 4 > sizeof buf) return 0;
    memcpy(buf, domain, domLen);
    memcpy(buf + domLen, nonce, nonceLen);
    buf[domLen + nonceLen + 0] = (uint8_t)(pid & 0xff);
    buf[domLen + nonceLen + 1] = (uint8_t)((pid >> 8) & 0xff);
    buf[domLen + nonceLen + 2] = (uint8_t)((pid >> 16) & 0xff);
    buf[domLen + nonceLen + 3] = (uint8_t)((pid >> 24) & 0xff);
    return hmac_sha256(g_key, g_keyLen, buf, domLen + nonceLen + 4, out);
}

/* --------------------------------------------------------------- leitura */
static HANDLE g_proc = NULL;
static uint64_t g_moduleBase = 0;
static uint64_t g_moduleSize = 0;
static DWORD g_selfPid = 0;
static int g_inProcess = 0;

static int mem_read(uint64_t addr, void *out, size_t size)
{
    SIZE_T got = 0;
    if (g_inProcess) {
        MEMORY_BASIC_INFORMATION mbi;
        if (!VirtualQuery((LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) return 0;
        if (mbi.State != MEM_COMMIT) return 0;
        if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return 0;
        if ((uint64_t)(uintptr_t)mbi.BaseAddress + mbi.RegionSize < addr + size) return 0;
        memcpy(out, (const void *)(uintptr_t)addr, size);
        return 1;
    }
    if (!g_proc) return 0;
    return ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)addr, out, size, &got) && got == size;
}

/* Le o nome de uma ENTIDADE a partir do campo `name`.
 *
 * BUG CORRIGIDO (G05, 2026-11-17): o campo e' um `std::string` do MSVC, NAO um
 * buffer inline de 32 bytes. Layout do objeto (medido no PID 27412, build
 * 48c41bd4):
 *
 *   +0x70  union { char buf[16]; char *ptr; }   <- SSO ou ponteiro
 *   +0x78  size_t size
 *   +0x80  size_t capacity
 *
 * Com capacity <= 15 o texto vive em +0x70 (SSO) e o ler inline funciona. Com
 * capacity >= 16 o texto esta' no heap e +0x70 e' um PONTEIRO.
 *
 * MEDIDO (duas formas no MESMO build 48c41bd4, personagens diferentes):
 *
 *   - PID 27412, nome de 16 chars: capacity=31, size>0, ptr=0x2012abb0a10;
 *   - PID 9500,  "Banedenovootario": ptr=0x28ebf07f610, size=0, cap=16, texto
 *     no ponteiro e terminado em NUL.
 *
 * Exigir `size > 0` reprovava o segundo caso: caia no ramo SSO, lia os bytes do
 * ponteiro (`10 f6 07 bf`) e devolvia 0. O jogador em (3289,2113) hp 100 nao era
 * aceito e a DLL publicava (0,0,0) `online=0` mesmo com `gate=1`. `size` agora
 * e' opcional; `cap` limita a leitura.
 *
 * Ler inline devolvia bytes de ponteiro, `layout_looks_sane` reprovava o nome e
 * NENHUM layout era aceito — a DLL caia no scanner por nome e aceitava falsos
 * positivos (um buffer com a string "chaseMode" em +0x30), publicando posicao
 * (0,0,0) e hp 0 com o runtime pronto (`gate=1`). O nome anterior tinha 14
 * chars e cabia no SSO: o defeito so' apareceu ao trocar de personagem.
 *
 * Regra: se `capacity` estiver num intervalo plausivel e >= 16, seguir o
 * ponteiro; caso contrario ler inline. Nunca devolve lixo: se o ponteiro nao
 * for legivel ou o texto nao for imprimivel, devolve 0.
 */
static int read_name_from(const uint8_t *raw, size_t len, uint32_t off, char out[33])
{
    out[0] = 0;
    if ((size_t)off + 0x18 > len) return 0;

    uint64_t ptr = 0;
    size_t size = 0, cap = 0;
    memcpy(&ptr, raw + off, 8);
    memcpy(&size, raw + off + 8, sizeof size);
    memcpy(&cap, raw + off + 0x10, sizeof cap);

    /* 15/16 e' a fronteira do SSO. Acima disso os dados estao no heap.
     *
     * CORRECAO 2026-11-18 (PID 9500, mesmo build): o objeto trazia
     * ptr=0x28ebf07f610, size=0, cap=16 e o texto terminado em NUL no
     * ponteiro. Exigir size>0 reprovava o jogador em (3289,2113) hp 100 — a
     * DLL publicava (0,0,0) e online=0. `size` agora e' opcional. */
    if (cap >= 16 && cap <= 4096) {
        size_t want;
        if (size > 0 && size <= 32) want = size;
        else want = cap < 32 ? cap : 32;
        if (want == 0) return 0;
        char heap[33];
        if (!mem_read(ptr, heap, want)) return 0;
        heap[want] = 0;
        size_t n = 0;
        while (n < want && heap[n]) {
            unsigned char c = (unsigned char)heap[n];
            if (c < 0x20 || c > 0x7e) return 0;
            out[n] = heap[n];
            n++;
        }
        out[n] = 0;
        return n > 0;
    }

    /* SSO: o texto esta' inline, no maximo 15 bytes + terminador. */
    size_t n = 0;
    while (n < 32 && raw[off + n]) {
        unsigned char c = raw[off + n];
        if (c < 0x20 || c > 0x7e) return 0;
        out[n] = (char)c;
        n++;
    }
    out[n] = 0;
    return n > 0;
}

/* Escrita em memoria ALHEIA ao proprio objeto.
 *
 * Usado APENAS pelo comando attack, para publicar o alvo em
 * [runtime+0x2528] antes de chamar o handler (que le o alvo dali, nao do
 * 2o argumento). Restaura o valor anterior logo depois.
 *
 * Exige PAGE_READWRITE. Se a pagina for read-only devolve 0 e o chamador
 * aborta sem chamar nada — melhor falhar do que corromper.
 */
static int write_mem(uint64_t addr, const void *in, size_t size)
{
    SIZE_T done = 0;
    if (g_inProcess) {
        MEMORY_BASIC_INFORMATION mbi;
        if (!VirtualQuery((LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) return 0;
        if (mbi.State != MEM_COMMIT) return 0;
        if (!(mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY |
                             PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)))
            return 0;
        if ((uint64_t)(uintptr_t)mbi.BaseAddress + mbi.RegionSize < addr + size) return 0;
        memcpy((void *)(uintptr_t)addr, in, size);
        return 1;
    }
    if (!g_proc) return 0;
    return WriteProcessMemory(g_proc, (LPVOID)(uintptr_t)addr, in, size, &done) && done == size;
}

static uint32_t rd_u32(uint64_t addr) { uint32_t v = 0; mem_read(addr, &v, 4); return v; }
static uint16_t rd_u16(uint64_t addr) { uint16_t v = 0; mem_read(addr, &v, 2); return v; }
static int32_t rd_i32(uint64_t addr) { int32_t v = 0; mem_read(addr, &v, 4); return v; }
static uint64_t rd_u64(uint64_t addr) { uint64_t v = 0; mem_read(addr, &v, 8); return v; }

typedef struct {
    uint32_t id;
    int32_t x, y;
    int16_t z;
    uint8_t hp;
    uint8_t type;
    char name[33];
    int canAttack;
    int isOwn;
    int isPlayer;
} entity_t;

/* Offsets do subobjeto base. MUDAM por build: o build 48c41bd4 (2026-11-09)
 * andou -0x10 em pos/id/name/hp/type/canAttack. `direction` (+0xB4), `gate`
 * (+0x164) e `autowalk` (+0xCF6) NAO andam.
 *
 * Antes eram #define fixos e o scanner morria com o layout errado (procurava
 * pos em +0x30, que neste build e o valor 1). Agora e runtime: o layout e
 * escolhido por layout_detect() na primeira leitura de entidade. */
typedef struct {
    uint32_t pos;      /* x em +pos, y em +pos+4 */
    uint32_t id;
    uint32_t name;
    uint32_t hp;
    uint32_t type;
} entity_layout_t;

#define LAYOUT_POS_DEFAULT     0x30u
#define LAYOUT_ID_DEFAULT      0x5Cu
#define LAYOUT_NAME_DEFAULT    0x80u
#define LAYOUT_HP_DEFAULT      0xC0u
#define LAYOUT_TYPE_DEFAULT    0x186u
#define LAYOUT_SHIFT           0x10u   /* build 48c41bd4 andou tudo -0x10 */

static entity_layout_t g_layout = { LAYOUT_POS_DEFAULT, LAYOUT_ID_DEFAULT,
                                    LAYOUT_NAME_DEFAULT, LAYOUT_HP_DEFAULT,
                                    LAYOUT_TYPE_DEFAULT };
static int g_layoutResolved = 0;

static uint64_t module_base_for_chain(void);

static entity_layout_t layout_default(void)
{
    entity_layout_t l = { LAYOUT_POS_DEFAULT, LAYOUT_ID_DEFAULT,
                          LAYOUT_NAME_DEFAULT, LAYOUT_HP_DEFAULT,
                          LAYOUT_TYPE_DEFAULT };
    return l;
}

static entity_layout_t layout_shifted(void)
{
    entity_layout_t l = { LAYOUT_POS_DEFAULT - LAYOUT_SHIFT,
                          LAYOUT_ID_DEFAULT - LAYOUT_SHIFT,
                          LAYOUT_NAME_DEFAULT - LAYOUT_SHIFT,
                          LAYOUT_HP_DEFAULT - LAYOUT_SHIFT,
                          LAYOUT_TYPE_DEFAULT - LAYOUT_SHIFT };
    return l;
}

/* Uma entidade de player valida: nome ASCII imprimivel no offset de nome,
 * coords plausiveis, e o primeiro qword (vtable) dentro da imagem.
 * Recebe o blob cru para nao depender de entity_read (que usa g_layout). */
static int layout_looks_sane(const uint8_t *raw, size_t len,
                             uint64_t base, const entity_layout_t *l)
{
    if (len < l->type + 1) return 0;
    int32_t x, y;
    memcpy(&x, raw + l->pos, 4);
    memcpy(&y, raw + l->pos + 4, 4);
    if (x <= 0 || y <= 0 || x > 65535 || y > 65535) return 0;
    uint8_t z = raw[l->pos + 8];
    if (z > 15) return 0;
    /* O nome e' std::string (SSO ou heap). Antes exigia texto inline, o que
     * reprovava qualquer personagem com nome > 15 chars e impedia o layout
     * de ser aceito. */
    char nm[33];
    if (!read_name_from(raw, len, l->name, nm)) return 0;
    if (l->hp < len && raw[l->hp] > 100) return 0;
    uint64_t vt = 0;
    memcpy(&vt, raw, 8);
    if (vt < base || vt > base + 0x10000000ULL) return 0;
    return 1;
}

/* Escolhe o layout lendo uma instancia ja conhecida (achada por vtable ou por
 * nome). Nao inventa: se nenhum layout passar, NAO marca como resolvido —
 * tenta de novo na proxima entidade (a primeira leitura pode ser uma copia
 * transiente do nome, sem vtable e sem coords plausiveis). */
static void layout_detect(uint64_t entVa)
{
    if (g_layoutResolved) return;
    uint64_t base = module_base_for_chain();
    if (!base) return;
    uint8_t raw[0x200];
    if (!mem_read(entVa, raw, sizeof raw)) return;
    entity_layout_t def = layout_default();
    entity_layout_t shf = layout_shifted();
    int okDef = layout_looks_sane(raw, sizeof raw, base, &def);
    int okShf = layout_looks_sane(raw, sizeof raw, base, &shf);
    if (okShf && !okDef) {
        g_layout = shf;
        g_layoutResolved = 1;
        log_line("layout DETECTADO: shifted -0x%x (pos=0x%x name=0x%x hp=0x%x id=0x%x type=0x%x) em 0x%llx",
                 LAYOUT_SHIFT, shf.pos, shf.name, shf.hp, shf.id, shf.type,
                 (unsigned long long)entVa);
    } else if (okDef) {
        g_layout = def;
        g_layoutResolved = 1;
        log_line("layout DETECTADO: default (pos=0x%x name=0x%x hp=0x%x id=0x%x type=0x%x) em 0x%llx",
                 def.pos, def.name, def.hp, def.id, def.type,
                 (unsigned long long)entVa);
    }
    /* falha: nao marca resolved. tenta na proxima. */
}

static int entity_read(uint64_t va, entity_t *e)
{
    uint8_t raw[0x200];
    if (!mem_read(va, raw, sizeof raw)) return 0;
    if (!g_layoutResolved) layout_detect(va);
    const entity_layout_t *L = &g_layout;
    memset(e, 0, sizeof *e);
    memcpy(&e->x, raw + L->pos, 4);
    memcpy(&e->y, raw + L->pos + 4, 4);
    memcpy(&e->z, raw + L->pos + 8, 2);
    memcpy(&e->id, raw + L->id, 4);
    /* O campo `name` e' std::string (SSO/heap), nao buffer inline. */
    if (!read_name_from(raw, sizeof raw, L->name, e->name)) e->name[0] = 0;
    e->hp = raw[L->hp];
    e->type = raw[L->type];
    e->canAttack = (e->type == 1 && e->hp > 0);
    e->isOwn = (e->type == 3);
    e->isPlayer = (e->type == 0);
    return 1;
}

/* localiza a entidade do jogador pelo nome, varrendo regioes legiveis.
 * Retorna 0 se nao encontrou. Nao inventa posicao. */
static uint64_t g_playerVa = 0;
static char g_playerName[33];
static int g_playerKnown = 0;

static int name_matches(const uint8_t *raw, const char *wanted)
{
    char name[33];
    uint32_t nameOff = g_layoutResolved ? g_layout.name : LAYOUT_NAME_DEFAULT;
    if (!read_name_from(raw, 0x200, nameOff, name)) return 0;
    return _stricmp(name, wanted) == 0;
}

/* Descobre o nome do jogador. Ordem:
 *   1. PKA_PLAYER_NAME no ambiente
 *   2. pka_player_name.txt ao lado da DLL / %TEMP%
 *   3. titulo da janela do jogo: "PokeAlliance - <nome>"
 *
 * NAO guarda resultado negativo: um processo ja injetado pode ganhar o arquivo
 * depois, ou a janela pode ser renomeada pelo launcher. Guardar NULL uma unica
 * vez congelaria um erro transitorio (era o bug que deixava o canal autenticado
 * mas com hp=0 para sempre). */
static int title_pid_filter = 0;
static char title_result[64];

static BOOL CALLBACK title_probe(HWND hwnd, LPARAM lparam)
{
    (void)lparam;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if ((int)pid != title_pid_filter) return TRUE;
    char title[256];
    if (!GetWindowTextA(hwnd, title, (int)sizeof title)) return TRUE;
    static const char prefix[] = "PokeAlliance - ";
    size_t plen = sizeof prefix - 1;
    if (_strnicmp(title, prefix, plen) != 0) return TRUE;
    const char *name = title + plen;
    if (!*name) return TRUE;
    snprintf(title_result, sizeof title_result, "%s", name);
    return FALSE;
}

static const char *player_name_from_title(void)
{
    title_pid_filter = (int)GetCurrentProcessId();
    title_result[0] = 0;
    EnumWindows(title_probe, 0);
    return title_result[0] ? title_result : NULL;
}

/* TTL do cache do nome do jogador.
 *
 * MEDIDO (2026-11-12, log de 4,8 MB / 44.602 linhas): 30.786 linhas eram
 * "nome do jogador lido de ... Usobot" — 69% do log. A causa: refresh_state()
 * roda a 20 Hz no canal de observacao e chamava esta funcao a cada tick, que
 * fazia fopen + fread + log_line SEMPRE.
 *
 * Isso e' I/O de disco na thread que serve o pipe, 20x/s. Nao muda o resultado
 * (o nome nao muda em runtime) e custa caro. Agora: leitura no maximo 1x a
 * cada PLAYER_NAME_TTL_MS, e log SO' quando o valor muda.
 *
 * Nao cachear negativo de forma permanente continua valendo: se o arquivo
 * aparecer depois, a proxima janela de TTL pega. */
#define PLAYER_NAME_TTL_MS 2000

static const char *player_name_config(void)
{
    static char name[64];
    static char cached[64];
    static DWORD cachedAt = 0;

    const char *env = getenv("PKA_PLAYER_NAME");
    if (env && *env) {
        snprintf(name, sizeof name, "%s", env);
        return name;
    }

    DWORD now = GetTickCount();
    if (cached[0] && (DWORD)(now - cachedAt) < PLAYER_NAME_TTL_MS) {
        snprintf(name, sizeof name, "%s", cached);
        return name;
    }
    cachedAt = now;

    char path[MAX_PATH];
    module_file(path, sizeof path, "pka_player_name.txt");
    FILE *f = path[0] ? fopen(path, "rb") : NULL;
    if (!f) {
        char tmp[MAX_PATH];
        DWORD m = GetTempPathA((DWORD)sizeof tmp, tmp);
        if (m > 0 && m < sizeof tmp) {
            snprintf(path, sizeof path, "%spka_player_name.txt", tmp);
            f = fopen(path, "rb");
        }
    }
    if (f) {
        size_t got = fread(name, 1, sizeof name - 1, f);
        fclose(f);
        name[got] = 0;
        size_t len = strlen(name);
        while (len && (name[len - 1] == '\r' || name[len - 1] == '\n' || name[len - 1] == ' '))
            name[--len] = 0;
        if (len) {
            if (_stricmp(cached, name) != 0) {
                log_line("nome do jogador lido de %s: %s", path, name);
                snprintf(cached, sizeof cached, "%s", name);
            }
            return name;
        }
    }

    const char *fromTitle = player_name_from_title();
    if (fromTitle) {
        snprintf(name, sizeof name, "%s", fromTitle);
        if (_stricmp(cached, name) != 0) {
            log_line("nome do jogador lido do titulo da janela: %s", name);
            snprintf(cached, sizeof cached, "%s", name);
        }
        return name;
    }
    return NULL;
}

/* Cadencia do canal de observacao, em ms.
 *
 * Le `pka_observe_hz.txt` ao lado da DLL (ou em %TEMP%). O conteudo e' o Hz
 * desejado: "20" -> 50 ms. Zero/ausente/invalido -> TELEMETRY_INTERVAL_MS
 * (comportamento do fornecedor, 1000 ms).
 *
 * Lido a cada chamada: mudar o arquivo em runtime ajusta a cadencia sem
 * reinjetar a DLL. */
static DWORD observe_interval_ms(void)
{
    char path[MAX_PATH];
    module_file(path, sizeof path, "pka_observe_hz.txt");
    FILE *f = path[0] ? fopen(path, "rb") : NULL;
    if (!f) {
        char tmp[MAX_PATH];
        DWORD m = GetTempPathA((DWORD)sizeof tmp, tmp);
        if (m > 0 && m < sizeof tmp) {
            snprintf(path, sizeof path, "%spka_observe_hz.txt", tmp);
            f = fopen(path, "rb");
        }
    }
    if (!f) return TELEMETRY_INTERVAL_MS;

    char buf[32];
    size_t got = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[got] = 0;
    long hz = strtol(buf, NULL, 10);
    if (hz < OBSERVE_MIN_HZ || hz > OBSERVE_MAX_HZ) return TELEMETRY_INTERVAL_MS;

    DWORD ms = (DWORD)(1000 / hz);
    if (ms < 1) ms = 1;
    return ms;
}

static uint64_t find_player(void)
{
    const char *wanted = player_name_config();
    if (!wanted || !*wanted) return 0;
    /* Sem o modulo do jogo neste processo nao ha entidade para achar: a
     * varredura so encontraria strings soltas e devolveria VA invalido. */
    if (!module_base_for_chain()) return 0;
    MEMORY_BASIC_INFORMATION mbi;
    uint64_t addr = 0x10000;
    uint64_t limit = 0x7FFFFFFFFFFFULL;
    uint8_t *buf = (uint8_t *)malloc(0x100000);
    if (!buf) return 0;

    while (addr < limit) {
        /* in-process: VirtualQueryEx(NULL/self) enumerara o proprio modulo;
         * so funciona com the own pseudo-handle. Fora do processo exige g_proc. */
        HANDLE queryProc = g_inProcess ? GetCurrentProcess() : g_proc;
        if (!queryProc) { free(buf); return 0; }
        if (!VirtualQueryEx(queryProc, (LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) break;
        uint64_t base = (uint64_t)(uintptr_t)mbi.BaseAddress;
        uint64_t size = (uint64_t)mbi.RegionSize;
        int readable = (mbi.State == MEM_COMMIT) &&
                       (mbi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                                       PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                       PAGE_EXECUTE_WRITECOPY)) &&
                       !(mbi.Protect & PAGE_GUARD);
        if (readable) {
            for (uint64_t off = 0; off < size; off += 0x100000) {
                size_t chunk = (size_t)((size - off) < 0x100000 ? (size - off) : 0x100000);
                SIZE_T got = 0;
                if (g_inProcess) {
                    got = chunk;
                    memcpy(buf, (const void *)(uintptr_t)(base + off), chunk);
                } else if (!ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)(base + off),
                                              buf, chunk, &got)) {
                    continue;
                }
                if (got < 0x190) continue;
                for (size_t i = 0; i + 0x190 <= got; i += 8) {
                    if (!name_matches(buf + i, wanted)) continue;
                    uint64_t va = base + off + i;
                    uint64_t vtable = 0;
                    memcpy(&vtable, buf + i, 8);
                    if (!vtable) continue;
                    /* o layout pode estar shifted; resolve antes de ler o type */
                    if (!g_layoutResolved) layout_detect(va);
                    uint32_t typeOff = g_layout.type;
                    if (i + typeOff >= got) continue;
                    uint8_t type = buf[i + typeOff];
                    if (type != 0) continue;
                    snprintf(g_playerName, sizeof g_playerName, "%s", wanted);
                    g_playerKnown = 1;
                    free(buf);
                    log_line("jogador %s em 0x%llx", wanted, (unsigned long long)va);
                    return va;
                }
            }
        }
        if (base + size <= addr) break;
        addr = base + size;
    }
    free(buf);
    return 0;
}

/* --------------------------------------------------------- estado/publica */
static int32_t g_healthPercent = 0;
static uint32_t g_targetId = 0;
static int g_online = 0;

/* Posicao do player, atualizada por refresh_state().
 *
 * WHY SEPARAR: antes, build_telemetry chamava entity_read(g_playerVa) por
 * conta propria. Se o cache estivesse stale, o telemetry publicava posicao
 * congelada SEM que refresh_state soubesse. Agora ha uma unica fonte: quem
 * resolve o player (refresh_state) tambem publica a posicao. build_telemetry
 * so' le estas globais. */
static int32_t g_posX = 0, g_posY = 0;
static uint8_t g_posZ = 0;
static int g_havePos = 0;

/* base do modulo do jogo neste processo. Injetado no jogo, o modulo do jogo e
 * o proprio executavel. Injetado em OUTRO processo (teste), o vtable RVA nao
 * existe la - devolver a base do processo faria a cadeia ler lixo e ainda
 * "achar" um jogador falso. */
static uint64_t module_base_for_chain(void)
{
    if (g_inProcess) {
        HMODULE game = GetModuleHandleA("PokeAlliance_dx.exe");
        return game ? (uint64_t)(uintptr_t)game : 0;
    }
    return g_moduleBase;
}

/* ------------------------------------------------------ localizar jogador
 * Tres metodos, em ordem de confiabilidade:
 *
 *  1. VTABLE (principal). Os RVAs de vtable MUDAM a cada build:
 *       82eadedc -> player 0x1FAC310  creature 0x1FAEF08  monster 0x1FB0210
 *       473df25c -> player 0x1F3F1F0  creature 0x1F41E58  monster 0x1F43060
 *     Entao o RVA conhecido e apenas ATALHO: valida-se que aponta para um
 *     vtable de verdade (primeiro slot = funcao dentro da imagem). Se falhar,
 *     resolve por RTTI (type descriptor ".?AVLocalPlayer@@" + locator).
 *  2. CADEIA de ponteiros (DEFAULT_CHAINS do pka_live_session.py). Caiu em
 *     desuso neste build: as cadeias estao quebradas (o Python tambem cai no
 *     fallback).
 *  3. NOME. Ultimo recurso: acha copias transitorias no heap, com VA que
 *     muda, entao exige revalidacao a cada ciclo.
 */
#define PLAYER_VTABLE_RVA_82EADEDC 0x1FAC310ULL
#define PLAYER_VTABLE_RVA_473DF25C 0x1F3F1F0ULL
/* build 48c41bd4 (2026-11-09) — confirmado por RTTI e pelo global do
 * LocalPlayer em docs/POSICAO_CONFIRMADA.md */
#define PLAYER_VTABLE_RVA_48C41BD4 0x1FB5660ULL
/* build 2026-11-19 (cliente atualizado pelo launcher) — vtable do objeto em
 * [runtime+0x2528], com posicao em +0x20 lendo (957,1405) do personagem */
#define PLAYER_VTABLE_RVA_20261119 0x1FDB2A8ULL

typedef struct { uint32_t rva; uint8_t offCount; uint16_t offsets[4]; } player_chain16_t;

static const player_chain16_t PLAYER_CHAINS16[] = {
    { 0x392E9C0, 0, { 0 } },
    { 0x392E9B8, 1, { 0x10 } },
    { 0x392E9F8, 1, { 0x1A8 } },
    { 0x392EA00, 1, { 0x1B8 } },
    { 0x3938930, 1, { 0x110 } },
    { 0x3938938, 1, { 0x120 } },
};
#define PLAYER_CHAIN_COUNT (sizeof PLAYER_CHAINS16 / sizeof PLAYER_CHAINS16[0])

static int entity_is_player(const entity_t *e, const char *wanted);

/* le um bloco da imagem do modulo (in-process: copia; externo: RPM) */
static int module_read(uint64_t base, uint64_t offset, void *out, size_t size)
{
    uint64_t addr = base + offset;
    SIZE_T got = 0;
    if (g_inProcess) {
        MEMORY_BASIC_INFORMATION mbi;
        if (!VirtualQuery((LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) return 0;
        if (mbi.State != MEM_COMMIT) return 0;
        if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return 0;
        if ((uint64_t)(uintptr_t)mbi.BaseAddress + mbi.RegionSize < addr + size) return 0;
        memcpy(out, (const void *)(uintptr_t)addr, size);
        return 1;
    }
    if (!g_proc) return 0;
    return ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)addr, out, size, &got) && got == size;
}

/* um vtable de verdade tem, no slot 0, um ponteiro para dentro da imagem */
static int looks_like_vtable(uint64_t base, uint64_t vtableVa)
{
    uint64_t firstFn = 0;
    if (!mem_read(vtableVa, &firstFn, 8)) return 0;
    if (firstFn < base) return 0;
    if (firstFn > base + 0x10000000ULL) return 0;
    return 1;
}

/* vtable do LocalPlayer por RTTI MSVC: acha o type descriptor pelo nome
 * decorado, localiza o CompleteObjectLocator que aponta para ele, e o qword
 * que guarda esse COL (o slot [vtable-8]). */
static uint64_t resolve_vtable_by_rtti(uint64_t base, const char *class_name)
{
    /* Varre a IMAGEM em blocos, respeitando o fim de cada REGIAO de memoria.
     *
     * HISTORICO (quatro tentativas, tres erradas) — o mesmo algoritmo funciona
     * em Python e falhava em C:
     *   v1: chunks fixos de 1 MB. Nome na fronteira entre chunks nunca casa.
     *       `LocalPlayer` passava por sorte, `Monster` nao.
     *   v2: ler CHUNK+OVERLAP de uma vez. module_read recusa quando a leitura
     *       cruza o fim da regiao -> sempre 0.
     *   v3: avancar CHUNK-OVERLAP. Passo de 64 B = 65536 iteracoes de 1 MB.
     *   v4: chunk + sobra em duas leituras. Funcionou EXTERNO (Python provou
     *       RVA 0x237b168), mas DENTRO do processo as regioes nao tem 1 MB
     *       contiguos — VirtualQuery devolve pedacos menores e a leitura do
     *       chunk inteiro falhava, pulando a regiao.
     *
     * v5 (esta): enumera as REGIOES via VirtualQuery e varre cada uma no seu
     * tamanho real, levando OVERLAP de sobra para o nome na fronteira. */
    char decorated[128];
    snprintf(decorated, sizeof decorated, ".?AV%s@@", class_name);
    const size_t nameLen = strlen(decorated);
    const uint64_t SCAN_LIMIT = 0x10000000ULL;
    const size_t OVERLAP = 64;

    uint8_t *buf = (uint8_t *)malloc(0x100000 + OVERLAP);
    if (!buf) return 0;

    HANDLE queryProc = g_inProcess ? GetCurrentProcess() : g_proc;
    if (!queryProc) { free(buf); return 0; }

    uint64_t tdRva = UINT64_MAX;
    uint64_t addr = base;
    const uint64_t end = base + SCAN_LIMIT;

    while (addr < end && tdRva == UINT64_MAX) {
        MEMORY_BASIC_INFORMATION mbi;
        if (!VirtualQueryEx(queryProc, (LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) break;
        uint64_t rbase = (uint64_t)(uintptr_t)mbi.BaseAddress;
        uint64_t rsize = (uint64_t)mbi.RegionSize;
        int readable = (mbi.State == MEM_COMMIT) &&
                       (mbi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                                       PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                       PAGE_EXECUTE_WRITECOPY)) &&
                       !(mbi.Protect & PAGE_GUARD);

        if (readable && rbase < end) {
            uint64_t stop = rbase + rsize;
            if (stop > end) stop = end;
            uint64_t cur = rbase;
            while (cur < stop && tdRva == UINT64_MAX) {
                size_t want = (size_t)((stop - cur) < 0x100000 ? (stop - cur) : 0x100000);
                SIZE_T got = 0;
                int ok;
                if (g_inProcess) {
                    got = want;
                    memcpy(buf, (const void *)(uintptr_t)cur, want);
                    ok = 1;
                } else {
                    ok = ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)cur, buf, want, &got);
                }
                if (ok && got > 0) {
                    size_t avail = (size_t)got;
                    if (avail >= nameLen && cur + avail < stop) {
                        SIZE_T tail = 0;
                        uint64_t taddr = cur + avail;
                        size_t tw = (size_t)((stop - taddr) < OVERLAP ? (stop - taddr) : OVERLAP);
                        if (g_inProcess) {
                            memcpy(buf + avail, (const void *)(uintptr_t)taddr, tw);
                            tail = (SIZE_T)tw;
                        } else {
                            ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)taddr,
                                              buf + avail, tw, &tail);
                        }
                        avail += tail;
                    }
                    for (size_t i = 0; i + nameLen <= avail; i++) {
                        if (memcmp(buf + i, decorated, nameLen) != 0) continue;
                        uint64_t rva = (cur - base) + i;
                        if (rva < 0x10) continue;
                        tdRva = rva - 0x10;
                        break;
                    }
                }
                cur += want;
            }
        }
        if (rbase + rsize <= addr) break;
        addr = rbase + rsize;
    }

    /* acha o COL: signature 1 seguida (12 bytes depois) do RVA do descritor.
     * Mesma varredura por regiao da etapa anterior. */
    uint32_t want = (uint32_t)tdRva;
    uint64_t colRva = UINT64_MAX;
    {
        uint64_t a = base;
        while (a < end && colRva == UINT64_MAX) {
            MEMORY_BASIC_INFORMATION mbi;
            if (!VirtualQueryEx(queryProc, (LPCVOID)(uintptr_t)a, &mbi, sizeof mbi)) break;
            uint64_t rb = (uint64_t)(uintptr_t)mbi.BaseAddress;
            uint64_t rs = (uint64_t)mbi.RegionSize;
            int rd_ok = (mbi.State == MEM_COMMIT) &&
                        (mbi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                                        PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                        PAGE_EXECUTE_WRITECOPY)) &&
                        !(mbi.Protect & PAGE_GUARD);
            if (rd_ok && rb < end) {
                uint64_t stop = rb + rs; if (stop > end) stop = end;
                uint64_t cur = rb;
                while (cur < stop && colRva == UINT64_MAX) {
                    size_t w = (size_t)((stop - cur) < 0x100000 ? (stop - cur) : 0x100000);
                    SIZE_T g = 0;
                    if (g_inProcess) { g = w; memcpy(buf, (const void *)(uintptr_t)cur, w); }
                    else if (!ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)cur, buf, w, &g)) { cur += w; continue; }
                    for (size_t i = 12; i + 4 <= (size_t)g; i += 4) {
                        uint32_t value = 0;
                        memcpy(&value, buf + i, 4);
                        if (value != want) continue;
                        uint32_t sig = 0;
                        memcpy(&sig, buf + i - 12, 4);
                        if (sig != 1) continue;
                        colRva = (cur - base) + i - 12;
                        break;
                    }
                    cur += w;
                }
            }
            if (rb + rs <= a) break;
            a = rb + rs;
        }
    }
    if (colRva == UINT64_MAX) { free(buf); return 0; }

    /* vtable = qword que guarda o endereco do COL, mais 8.
     * Mesma varredura por regiao (o COL e' um qword, busca alinhada de 8). */
    uint64_t colVa = base + colRva;
    uint64_t vtable = 0;
    {
        uint64_t a = base;
        while (a < end && !vtable) {
            MEMORY_BASIC_INFORMATION mbi;
            if (!VirtualQueryEx(queryProc, (LPCVOID)(uintptr_t)a, &mbi, sizeof mbi)) break;
            uint64_t rb = (uint64_t)(uintptr_t)mbi.BaseAddress;
            uint64_t rs = (uint64_t)mbi.RegionSize;
            int rd_ok = (mbi.State == MEM_COMMIT) &&
                        (mbi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                                        PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                        PAGE_EXECUTE_WRITECOPY)) &&
                        !(mbi.Protect & PAGE_GUARD);
            if (rd_ok && rb < end) {
                uint64_t stop = rb + rs; if (stop > end) stop = end;
                uint64_t cur = rb;
                while (cur < stop && !vtable) {
                    size_t w = (size_t)((stop - cur) < 0x100000 ? (stop - cur) : 0x100000);
                    SIZE_T g = 0;
                    if (g_inProcess) { g = w; memcpy(buf, (const void *)(uintptr_t)cur, w); }
                    else if (!ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)cur, buf, w, &g)) { cur += w; continue; }
                    for (size_t i = 0; i + 8 <= (size_t)g; i += 8) {
                        uint64_t cand = 0;
                        memcpy(&cand, buf + i, 8);
                        if (cand == colVa) { vtable = cur + i + 8; break; }
                    }
                    cur += w;
                }
            }
            if (rb + rs <= a) break;
            a = rb + rs;
        }
    }
    free(buf);
    return vtable;
}

static uint64_t resolve_player_vtable(void)
{
    uint64_t base = module_base_for_chain();
    if (!base) return 0;
    static uint64_t cached = 0;
    if (cached) return cached;

    const uint64_t shortcuts[] = { PLAYER_VTABLE_RVA_20261119,
                                   PLAYER_VTABLE_RVA_48C41BD4,
                                   PLAYER_VTABLE_RVA_82EADEDC,
                                   PLAYER_VTABLE_RVA_473DF25C };
    for (size_t i = 0; i < sizeof shortcuts / sizeof shortcuts[0]; i++) {
        uint64_t cand = base + shortcuts[i];
        if (looks_like_vtable(base, cand)) {
            cached = cand;
            log_line("vtable do player pelo atalho RVA 0x%llx", (unsigned long long)shortcuts[i]);
            return cached;
        }
    }

    uint64_t byRtti = resolve_vtable_by_rtti(base, "LocalPlayer");
    if (byRtti && looks_like_vtable(base, byRtti)) {
        cached = byRtti;
        log_line("vtable do player por RTTI: rva 0x%llx", (unsigned long long)(byRtti - base));
        return cached;
    }

    log_line("vtable do player NAO encontrado (atalho e RTTI falharam)");
    return 0;
}

/* ------------------------------------------------- handler de attack
 *
 * O RVA do handler muda por build. Medido:
 *   build 2026-11-04 (doc DISPATCH_LIVE.md) : exe+0x783000
 *   build 2026-11-09 (PID 13952)            : exe+0x784ba0   (+0x1BA0)
 *
 * O que NAO muda e' o padrao de bytes do prologo:
 *
 *   48 89 5c 24 18   mov [rsp+0x18], rbx
 *   48 89 74 24 20   mov [rsp+0x20], rsi
 *   57               push rdi
 *   48 83 ec 50      sub rsp, 0x50
 *   48 8b 05 xx xx xx xx  mov rax, [rip+..]     ; stack cookie
 *   48 33 c4         xor rax, rsp
 *   41 0f b6 f0      movzx esi, r8b             ; flag
 *   48 8b fa         mov rdi, rdx               ; entidade
 *
 * A sequencia `41 0f b6 f0 48 8b fa` (6 bytes) e' o discriminante: so'
 * aparece em 5 lugares no modulo, e o handler e' o que tem o cookie
 * (`48 8b 05 .. .. .. .. 48 33 c4`) imediatamente antes. Localizado assim
 * em 2026-11-09: 0x784ba0.
 *
 * IMPORTANTE: localizar NAO e' chamar. Chamar exige stack cookie valido e
 * alinhamento de pilha. Esta funcao so' resolve o endereco para validacao e
 * log; a chamada fica atras de PKA_ATTACK_FIRE=1 e ainda nao foi validada
 * neste build. Ver docs/CANAL_NATIVO_TESTE.md.
 */
static uint64_t g_attackHandler = 0;

static uint64_t resolve_attack_handler(void)
{
    if (g_attackHandler) return g_attackHandler;
    uint64_t base = module_base_for_chain();
    if (!base) return 0;

    /* discriminante: movzx esi,r8b ; mov rdi,rdx */
    static const uint8_t disc[] = { 0x41, 0x0f, 0xb6, 0xf0, 0x48, 0x8b, 0xfa };
    enum { CHUNK = 0x100000, SCAN_LIMIT = 0x8000000 };
    uint8_t *buf = (uint8_t *)malloc(CHUNK);
    if (!buf) return 0;

    for (uint64_t off = 0; off + CHUNK < SCAN_LIMIT && !g_attackHandler; off += CHUNK) {
        if (!module_read(base, off, buf, CHUNK)) continue;
        for (size_t i = 0; i + sizeof disc <= CHUNK; i++) {
            if (memcmp(buf + i, disc, sizeof disc) != 0) continue;
            /* recua buscando o prologo `48 89 5c 24 18` e o cookie antes dele.
             * Todo indice e' size_t e o limite inferior e' 0 — o loop para
             * em j == 0 sem underflow. */
            /* recua buscando o prologo `48 89 5c 24 18` e o cookie antes dele.
             * Indice ASSINADO: `size_t j >= from; j--` faz underflow em j==0
             * e o laco nunca termina (foi um crash real). */
            long lo = (long)i - 0x60;
            if (lo < 0) lo = 0;
            long funcStart = -1;
            for (long j = (long)i - 6; j >= lo; j--) {
                if (buf[j] == 0x48 && buf[j+1] == 0x89 && buf[j+2] == 0x5c &&
                    buf[j+3] == 0x24 && buf[j+4] == 0x18) {
                    for (long k = j; k + 12 < (long)i; k++) {
                        if (buf[k] == 0x48 && buf[k+1] == 0x8b && buf[k+2] == 0x05 &&
                            buf[k+7] == 0x48 && buf[k+8] == 0x33 && buf[k+9] == 0xc4) {
                            funcStart = j; break;
                        }
                    }
                }
                if (funcStart >= 0) break;
            }
            if (funcStart < 0) continue;
            g_attackHandler = base + off + (uint64_t)funcStart;
            log_line("handler de attack por pattern: rva 0x%llx (disc 0x%llx)",
                     (unsigned long long)(g_attackHandler - base),
                     (unsigned long long)(off + i));
            break;
        }
    }
    free(buf);
    if (!g_attackHandler) log_line("handler de attack NAO encontrado por pattern");
    return g_attackHandler;
}


/* procura instancias cujo primeiro qword seja o vtable do LocalPlayer */
static uint64_t find_player_by_vtable(void)
{
    uint64_t base = module_base_for_chain();
    if (!base) return 0;
    uint64_t vtable = resolve_player_vtable();
    if (!vtable) return 0;
    const char *wanted = player_name_config();

    MEMORY_BASIC_INFORMATION mbi;
    uint64_t addr = 0x10000;
    const uint64_t limit = 0x7FFFFFFFFFFFULL;
    uint8_t *buf = (uint8_t *)malloc(0x100000);
    if (!buf) return 0;

    while (addr < limit) {
        if (!VirtualQueryEx(g_proc ? g_proc : GetCurrentProcess(),
                            (LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) break;
        uint64_t rbase = (uint64_t)(uintptr_t)mbi.BaseAddress;
        uint64_t size = (uint64_t)mbi.RegionSize;
        int readable = (mbi.State == MEM_COMMIT) &&
                       (mbi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                                       PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                       PAGE_EXECUTE_WRITECOPY)) &&
                       !(mbi.Protect & PAGE_GUARD);
        if (readable) {
            for (uint64_t off = 0; off < size; off += 0x100000) {
                size_t chunk = (size_t)((size - off) < 0x100000 ? (size - off) : 0x100000);
                SIZE_T got = 0;
                if (g_inProcess) {
                    got = chunk;
                    memcpy(buf, (const void *)(uintptr_t)(rbase + off), chunk);
                } else if (!ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)(rbase + off),
                                              buf, chunk, &got)) {
                    continue;
                }
                if (got < 8) continue;
                for (size_t i = 0; i + 0x190 <= got; i += 8) {
                    uint64_t candidate = 0;
                    memcpy(&candidate, buf + i, 8);
                    if (candidate != vtable) continue;
                    uint64_t va = rbase + off + i;
                    entity_t e;
                    if (!entity_read(va, &e)) continue;
                    if (!entity_is_player(&e, wanted)) continue;
                    free(buf);
                    return va;
                }
            }
        }
        if (rbase + size <= addr) break;
        addr = rbase + size;
    }
    free(buf);
    return 0;
}

static uint64_t resolve_player_chain(void)
{
    uint64_t base = module_base_for_chain();
    if (!base) return 0;
    for (size_t c = 0; c < PLAYER_CHAIN_COUNT; c++) {
        const player_chain16_t *chain = &PLAYER_CHAINS16[c];
        uint64_t value = rd_u64(base + chain->rva);
        int ok = value != 0;
        for (uint8_t i = 0; ok && i < chain->offCount; i++) {
            value = rd_u64(value + chain->offsets[i]);
            ok = value != 0;
        }
        if (ok) return value;
    }
    return 0;
}

/* descobre a base do modulo quando lendo de fora (modo externo) */
static void resolve_module_base(void)
{
    if (g_inProcess) {
        g_moduleBase = (uint64_t)(uintptr_t)GetModuleHandleA(NULL);
        return;
    }
    if (!g_proc) return;
    HMODULE mods[1024];
    DWORD needed = 0;
    if (!EnumProcessModulesEx(g_proc, mods, (DWORD)sizeof mods, &needed, LIST_MODULES_ALL)) return;
    DWORD count = needed / sizeof(HMODULE);
    for (DWORD i = 0; i < count; i++) {
        char name[MAX_PATH];
        if (!GetModuleBaseNameA(g_proc, mods[i], name, (DWORD)sizeof name)) continue;
        if (_strnicmp(name, "PokeAlliance_dx.exe", 19) == 0) {
            MODULEINFO info;
            if (!GetModuleInformation(g_proc, mods[i], &info, sizeof info)) continue;
            g_moduleBase = (uint64_t)(uintptr_t)info.lpBaseOfDll;
            g_moduleSize = info.SizeOfImage;
            log_line("modulo base=0x%llx size=0x%llx",
                     (unsigned long long)g_moduleBase, (unsigned long long)g_moduleSize);
            return;
        }
    }
}

/* Valida que a memoria no VA ainda e a entidade do jogador.
 * Exige nome, tipo de player, id plausivel e coordenadas dentro do mapa. */
#define MAP_COORD_MAX 65534

static int entity_is_player(const entity_t *e, const char *wanted)
{
    if (!e->name[0]) return 0;
    if (e->type != 0) return 0;
    if (e->id == 0) return 0;
    if (e->x < 0 || e->x > MAP_COORD_MAX || e->y < 0 || e->y > MAP_COORD_MAX) return 0;
    if (e->z < 0 || e->z > 15) return 0;
    if (!wanted || !*wanted) return 0;
    return _stricmp(e->name, wanted) == 0;
}

static void refresh_state(void)
{
    const char *wanted = player_name_config();

    /* 0. VA memorizado, revalidado (mais barato)
     *
     * STALE CHECK (2026-11-12): `g_playerVa` pode sobreviver a uma transicao
     * de mapa e continuar apontando para uma copia antiga do LocalPlayer. A
     * copia mantem nome/hp/id validos, entao `entity_is_player` aprova — mas a
     * POSICAO congela. Medido: DLL publicava (956,1401) enquanto o global ja'
     * era (958,1401).
     *
     * Deteccao: se o global [base+GLOBAL_LP_RVA] existe e e' DIFERENTE de
     * g_playerVa, o cache esta' velho. Nesse caso descartamos sem nem ler.
     * E' barato: uma leitura de 8 bytes. */
    if (g_playerVa) {
        uint64_t baseLp = module_base_for_chain();
        uint64_t globalLp = 0;
        if (baseLp && mem_read(baseLp + 0x39F8E08ULL, &globalLp, sizeof globalLp)
            && globalLp && globalLp != g_playerVa) {
            log_line("player VA stale (cache=%#llx global=%#llx); re-resolvendo",
                     (unsigned long long)g_playerVa, (unsigned long long)globalLp);
            g_playerVa = 0;
        }
    }
    if (g_playerVa) {
        entity_t p;
        if (entity_read(g_playerVa, &p) && entity_is_player(&p, wanted)) {
            g_healthPercent = (int32_t)p.hp;
            g_online = (p.hp > 0) ? 1 : 0;
            g_posX = p.x; g_posY = p.y; g_posZ = p.z; g_havePos = 1;
            return;
        }
        g_playerVa = 0;
    }

    /* 1. vtable do LocalPlayer (fonte principal, RVA estavel) */
    uint64_t vtVa = find_player_by_vtable();
    if (vtVa) {
        entity_t p;
        if (entity_read(vtVa, &p) && entity_is_player(&p, wanted)) {
            g_playerVa = vtVa;
            g_healthPercent = (int32_t)p.hp;
            g_online = (p.hp > 0) ? 1 : 0;
            g_posX = p.x; g_posY = p.y; g_posZ = p.z; g_havePos = 1;
            log_line("jogador via vtable em 0x%llx", (unsigned long long)vtVa);
            return;
        }
    }

    /* 2. cadeia de ponteiros (quebrada neste build; mantida por compatibilidade) */
    uint64_t chainVa = resolve_player_chain();
    if (chainVa) {
        entity_t p;
        if (entity_read(chainVa, &p) && entity_is_player(&p, wanted)) {
            g_playerVa = chainVa;
            g_healthPercent = (int32_t)p.hp;
            g_online = (p.hp > 0) ? 1 : 0;
            g_posX = p.x; g_posY = p.y; g_posZ = p.z; g_havePos = 1;
            return;
        }
    }

    /* 3. varredura por nome (ultimo recurso) */
    uint64_t va = find_player();
    if (va) {
        entity_t p;
        if (entity_read(va, &p) && entity_is_player(&p, wanted)) {
            g_playerVa = va;
            g_healthPercent = (int32_t)p.hp;
            g_online = (p.hp > 0) ? 1 : 0;
            g_posX = p.x; g_posY = p.y; g_posZ = p.z; g_havePos = 1;
            return;
        }
    }

    g_online = 0;
    g_healthPercent = 0;
    g_havePos = 0;
}

/* Layout real do state (48 B), confirmado no tap de 2026-11-04:
 *   +0  tick (contador)   +4  isOnline     +8  healthPercent (0..100)
 *   +12 hp   double       +20 mana double  +28 cap double
 *   +36 targetId          +40 attackSeqNum +44 protoVersion = 854
 * hp/mana/cap usam -1.0 quando nao ha leitura; 0.0 seria valor falso.
 */
#define PROTO_VERSION 854u

static uint32_t g_stateTick = 0;
static uint32_t g_attackSeq = 0;

static size_t build_state(uint8_t out[48])
{
    memset(out, 0, 48);
    uint32_t tick = ++g_stateTick;
    uint32_t online = (uint32_t)g_online;
    uint32_t health = (uint32_t)g_healthPercent;
    double hpValue = g_online ? (double)g_healthPercent : -1.0;
    double mana = g_online ? 0.0 : -1.0;
    double cap = -1.0;
    uint32_t seq = g_attackSeq;
    uint32_t proto = PROTO_VERSION;
    memcpy(out + 0, &tick, 4);
    memcpy(out + 4, &online, 4);
    memcpy(out + 8, &health, 4);
    memcpy(out + 12, &hpValue, 8);
    memcpy(out + 20, &mana, 8);
    memcpy(out + 28, &cap, 8);
    memcpy(out + 36, &g_targetId, 4);
    memcpy(out + 40, &seq, 4);
    memcpy(out + 44, &proto, 4);
    return 48;
}

/* ---------------------------------------------------------- criaturas
 *
 * Fonte: RTTI "Monster", NAO "Creature".
 *
 * Medido em 2026-11-09 (PID 14296, build 48c41bd4):
 *   Creature vtable   -> 285 instancias, TODAS lixo (pos=65535, name vazio)
 *   Monster  vtable   -> 7 instancias, TODAS reais (nome, pos, id, type=4)
 *
 * Motivo: `Creature` e a base da hierarquia; os objetos derivados tem vtable
 * propria. Varredura pela vtable da base nao casa com os derivados (o qword
 * nao e a vtable da base) e o que casa e' struct de outro tipo.
 *
 * Layout dos campos e o MESMO do LocalPlayer (subobjeto base):
 *   +0x20 x,y  +0x28 z  +0x4C id  +0x70 name  +0xB0 hp  +0x176 type
 * Validado contra leitura direta: Charmeleon/Marowak com pos e id coerentes.
 *
 * Valores de `type` medidos ao vivo (PID 25900, 2026-11-09):
 *
 *   type=1  selvagem atacavel   Bellsprout/Weepinbell/Magnemite com pos VALIDA
 *   type=3  ALIADO do jogador   Dugtrio em (3314,2071) — 2 tiles do player,
 *                               acompanha. E' o Pokemon invocado, nao selvagem.
 *                               Aoid confirmou: e' o que ele carrega na mochila.
 *   type=4  fora de vista       Marowak/Lunatone/Gengar sempre em (65535,65535,255)
 *
 * IMPORTANTE — o Dugtrio com hp=99 que eu usei para "provar" que +0xB0 e' HP
 * era um ALIADO ferido, nao um selvagem. A conclusao sobre o offset continua
 * valida (o byte cai), mas a interpretacao estava errada: aliado nao entra na
 * lista de alvos.
 *
 * `canAttack` = type==1 && hp>0  (convencao do scan_creatures.py).
 * `isOwnPokemon` = type==3.
 */
#define MAX_CREATURES 64
#define CREATURE_TYPE_WILD 1
#define CREATURE_TYPE_OWN  3

typedef struct {
    uint32_t id;
    int32_t  x, y;
    uint8_t  z;
    uint8_t  hp;
    uint8_t  type;
    char     name[33];
} creature_t;

static creature_t g_creatures[MAX_CREATURES];
/* VA de cada criatura, paralelo a g_creatures. */
static uint64_t g_creatureVa[MAX_CREATURES];
/* Control block do shared_ptr<Monster> de cada criatura, paralelo aos dois
 * acima. Descoberto em 2026-11-10 (PID 9452):
 *
 *   vtable ?$_Ref_count_obj2@VMonster@@@std = exe+0x1fb2d98
 *   layout:  +0x00 vtable  +0x08 strong  +0x0c weak
 *            +0x10 vtable do Monster    +0x18 PONTEIRO DA CRIATURA
 *
 *   cb 0x2a593adb090 +0x18 -> 0x2a593adb0a0 = CRIATURA VIVA
 *   ... 11 de 11 casaram 1:1 com as instancias de Monster.
 *
 * Isso substitui o emprestimo do control block do Tile (LocalPlayer+0x9b0),
 * que era errado: o Tile nem sempre existe (ficou NULL com o personagem
 * parado) e o destrutor rodava sobre um objeto de outro tipo.
 */
static uint64_t g_creatureCb[MAX_CREATURES];
static int g_creatureCount = 0;
/* VA de cada criatura, paralelo a g_creatures. O handler de attack recebe o
 * PONTEIRO da entidade (nao o id), entao guardar o VA evita relocalizar. */
static uint64_t g_creatureVa[MAX_CREATURES];

/* --------------------------------------------------------- corpos (captura)
 * O pulso nao publica itens nem corpos: o jogo so' mantem a criatura enquanto
 * viva. Para o consumidor poder capturar, guardamos o ULTIMO tile de cada
 * selvagem que sumiu da varredura e publicamos como `items[]`
 * (`corpseId` = id da criatura, que e' o alvo de `useWith`).
 *
 * Medido em 2026-11-19: o alvo some do array ao morrer e nada era publicado
 * para ele. TTL de 60 s cobre o atraso tipico de captura. */
#define MAX_CORPSES 64
#define CORPSE_TTL_MS 60000ULL
typedef struct { uint32_t id; int32_t x, y; uint8_t z; ULONGLONG at; } corpse_t;
static corpse_t g_corpses[MAX_CORPSES];
static int g_corpseCount = 0;

static void corpse_forget_expired(void)
{
    ULONGLONG now = GetTickCount64();
    int w = 0;
    for (int i = 0; i < g_corpseCount; i++) {
        if (now - g_corpses[i].at > CORPSE_TTL_MS) continue;
        if (w != i) g_corpses[w] = g_corpses[i];
        w++;
    }
    g_corpseCount = w;
}

static void corpse_record(uint32_t id, int32_t x, int32_t y, uint8_t z)
{
    corpse_forget_expired();
    for (int i = 0; i < g_corpseCount; i++) {
        if (g_corpses[i].id == id) { g_corpses[i].at = GetTickCount64(); return; }
    }
    int slot;
    if (g_corpseCount < MAX_CORPSES) slot = g_corpseCount++;
    else {
        slot = 0;
        for (int i = 1; i < g_corpseCount; i++)
            if (g_corpses[i].at < g_corpses[slot].at) slot = i;
    }
    g_corpses[slot].id = id;
    g_corpses[slot].x = x;
    g_corpses[slot].y = y;
    g_corpses[slot].z = z;
    g_corpses[slot].at = GetTickCount64();
}

static const corpse_t *corpse_find(uint32_t id)
{
    corpse_forget_expired();
    for (int i = 0; i < g_corpseCount; i++)
        if (g_corpses[i].id == id) return &g_corpses[i];
    return NULL;
}

/* Runtime do jogo: objeto ESTATICO em .data (nao e' ponteiro).
 * Medido em 2026-11-09 (PID 7368): [runtime+0x2528] = LocalPlayer. */
#define RUNTIME_RVA 0x39F68E0ULL

/* Game::walk — build 48c41bd4 (2026-11-09/10).
 * Prologo conferido ao vivo: 48 89 5c 24 08 55 56 57 41 56 41 57 ...
 * Assinatura: rcx IGNORADO, edx = direcao (0..7), r8b = 0.
 * Dois chamadores no exe: 0x74742a (A/B/C) e 0x7b6381 (wrapper autowalk).
 * O RVA muda por build; o prologo + a posicao relativa ao wrapper sao a
 * ancora. tools/ pode reancorar por pattern se o prologo mudar. */
#define WALK_FN_RVA 0x780c90ULL

/* Consumidor de texto nativo — o caminho que o SHIBA usa para talk/combo.
 *
 * DESCOBERTA CENTRAL (2026-11-10, dump estatico + memoria viva do PID 20556):
 * o payload do Shiba NAO importa nem chama NENHUMA API de input ou foco.
 * Verificado por tabela de imports E por varredura de `call [rip+x]` em
 * 27.504.652 bytes de .text: zero referencias a PostMessage, SendMessage,
 * SendInput, keybd_event, SetForegroundWindow, GetForegroundWindow, SetFocus.
 * Os nomes so' aparecem nas tabelas de import herdadas do msftedit stomped.
 *
 * O caminho dele e' chamada de funcao dentro do processo:
 *
 *   0x67fbf0  handler de "!autocombo"  (cmp len,0xa + strncmp)
 *     monta "!autocombo <sequencia>" e chama
 *   0x785050  consumidor de texto  <- 5 callers reais no exe
 *     gates: [0x39cba98]!=0, [0x39cb958]!=NULL, [LP+0xb0]>0,
 *            [0x39cba9a]==0, [0x39cb998]!=NULL, 0x891600()!=0
 *     chama
 *   0x812240  corpo ofuscado (code virtualizado, call 0x4304e8a fora da .text)
 *
 * Assinatura de 0x785050 conferida ao vivo:
 *   rcx = objeto (recarregado de [0x39cb998] no corpo; entrada nao usada)
 *   edx = 1   (modo)
 *   r8d = 0
 *   r9  = &std::string  (NAO char*)
 *
 * ASSINATURA32 de 0x785050 conferida byte a byte na memoria do PID 20556:
 *   48 89 5c 24 08 48 89 6c 24 18 56 57 41 56 48 83 ec 70
 *   49 8b f9 41 8b f0 8b ea 80 3d 27 6a 24 03
 *
 * NAO CHAMAR 0x812240 direto nem por tentativa: o retorno nao e' consumido
 * pelo caller (0x78511f salta sem testar EAX) e o corpo esta' virtualizado.
 * O que provamos aqui e' o mesmo caminho que o fornecedor usa, com os mesmos
 * gates e o mesmo tipo de argumento. */
#define TEXT_FN_RVA 0x785050ULL
/* Global do objeto de sessao usado em rcx (e recarregado dentro do consumidor). */
#define TEXT_CTX_RVA 0x39F8E48ULL
/* Gate de sessao: precisa ser != 0 (medido: 1). */
#define TEXT_GATE_RVA 0x39F8F48ULL
/* Flag de reentrada: precisa ser 0. */
#define TEXT_REENTRY_RVA 0x39F8F4AULL

/* ─── INTERPRETADOR DE "!autocombo" (exe+0x67fbf0) ───
 *
 * DESCOBERTA CRITICA (2026-11-14): `TEXT_FN_RVA` (0x785050) e' o consumidor
 * GENERICO de texto — o chat. Ele NAO interpreta comandos. Quando mandavamos
 * "!autocombo" ou "m5" por ele, o jogo tratava como fala de chat: nada de
 * combo. Foi por isso que o bot "usava so' a primeira habilidade".
 *
 * O interpretador de verdade esta' em exe+0x67fbf0, e quem o chama e' a
 * funcao de tratamento de chat em 0x4439b4, depois de comparar a mensagem:
 *
 *   0x443988  83 f8 0a         cmp eax,0x0a        ; tamanho == 10
 *   0x44398b  4c 0f 42 e8      cmovb r13,rax
 *   0x44399b  48 8d 15 ..      lea rdx,"!autocombo" ; prefixo
 *   0x4439a2  e8 .. .. ..      call <strncmp>
 *   0x4439ac  49 83 fd 0a      cmp r13,0x0a       ; confirma 10 bytes
 *   0x4439b4  e8 37 c2 23 00   call 0x67fbf0      ; <<< INTERPRETADOR
 *
 * ASSINATURA (lida do proprio prologo de 0x67fbf0):
 *
 *   void interpretador(std::string *msg)    // rcx
 *
 *   +000  40 55              push rbp
 *   +028  48 8b d9           mov  rbx,rcx          ; guarda o ponteiro
 *   +04b  4c 8b 41 10        mov  r8,[rcx+0x10]    ; size
 *   +04f  48 83 79 18 0f     cmp  qword[rcx+0x18],0xf   ; cap > 15?
 *   +054  76 03              jbe  +3
 *   +056  48 8b 09           mov  rcx,[rcx]        ; ptr heap
 *   +072  49 83 f8 0a        cmp  r8,10            ; <<< EXIGE len == 10
 *   +076  0f 85 .. .. ..     jne  sair             ; senao SAI em silencio
 *   +07b  48 8d 15 .. ..     lea  rdx,"!autocombo"
 *   +082  e8 .. .. ..        call strncmp
 *   +087  0f 85 .. .. ..     jne  sair             ; senao SAI
 *
 * CONSEQUENCIA MEDIDA: mandar "!autocombo m5" (13 bytes) e' REJEITADO pelo
 * `cmp r8,10`. O Shiba manda SO' "!autocombo" — a sequencia de skills vem da
 * config que ele ja' empurrou para o runtime (`combo.sequenceText`), nao do
 * texto do comando.
 *
 * O layout de std::string e' o MESMO que ja' montamos para 0x785050
 * (union buf/ptr em +0, size em +0x10, capacity em +0x18), entao o corpo do
 * game_call_hook serve: so' o endereco da funcao muda. */
#define COMBO_INTERP_RVA 0x67fbf0ULL

/* Disparo real do attack.
 *
 * Lido de `pka_attack_fire.txt` ao lado da DLL, com o conteudo "1".
 * Variavel de ambiente NAO serve: processo ja em execucao nao herda ambiente
 * novo — `set PKA_ATTACK_FIRE=1` no shell nao chega no jogo.
 *
 * Sem o arquivo (ou com conteudo != 1) o comando e' DRY-RUN: resolve tudo,
 * loga, e devolve status 4 sem chamar o handler.
 */
static int attack_fire_enabled(void)
{
    int enabled = 0;
    char path[MAX_PATH];
    if (module_file(path, sizeof path, "pka_attack_fire.txt")) {
        {
            {
                FILE *f = fopen(path, "r");
                if (f) {
                    char buf[8] = { 0 };
                    size_t got = fread(buf, 1, sizeof buf - 1, f);
                    fclose(f);
                    buf[got] = 0;
                    enabled = (buf[0] == '1');
                    log_line("attack fire: arquivo %s = \"%s\" -> %s", path, buf,
                             enabled ? "DISPARA" : "dry-run");
                }
            }
        }
    }
    return enabled;
}

/* Aliado invocado (type==3). Separado da lista de alvos: e' o Pokemon que o
 * jogador carrega, nao uma criatura selvagem. Alimenta ownSummonId/pokemonName
 * do contrato de telemetria. */
static creature_t g_ownSummon;
static int g_haveOwnSummon = 0;
static uint64_t g_monsterVtable = 0;

static uint64_t resolve_monster_vtable(void)
{
    /* Duas threads chamam isto (scanner_thread e a sessao, no primeiro
     * telemetry). resolve_vtable_by_rtti aloca 1 MB e varre o modulo inteiro;
     * rodar duas vezes em paralelo e' desperdicio e o cache podia gravar
     * 0 depois de uma ter sucesso. Serializa. */
    static volatile LONG resolving = 0;
    if (g_monsterVtable) return g_monsterVtable;
    if (InterlockedCompareExchange(&resolving, 1, 0) != 0) {
        /* outra thread esta resolvendo: espera o cache popular */
        for (int i = 0; i < 100 && !g_monsterVtable; i++) Sleep(100);
        return g_monsterVtable;
    }
    uint64_t result = 0;
    uint64_t base = module_base_for_chain();
    if (base) {
        uint64_t vt = resolve_vtable_by_rtti(base, "Monster");
        log_line("resolve Monster: rtti devolveu %s (base=%#llx)",
                 vt ? "vtable" : "0", (unsigned long long)base);
        if (vt && looks_like_vtable(base, vt)) {
            g_monsterVtable = vt;
            result = vt;
            log_line("vtable do Monster por RTTI: rva 0x%llx", (unsigned long long)(vt - base));
        } else if (vt) {
            log_line("vtable do Monster REJEITADA por looks_like_vtable: %#llx",
                     (unsigned long long)vt);
        }
    } else {
        log_line("resolve Monster: module_base_for_chain devolveu 0");
    }
    if (!result) log_line("vtable do Monster NAO encontrado");
    InterlockedExchange(&resolving, 0);
    return result;
}

/* Uma criatura viva: nome ASCII, tipo conhecido, id != 0, coords no mapa. */
static int creature_is_valid(const creature_t *c)
{
    if (!c->name[0]) return 0;
    if (c->id == 0) return 0;
    if (c->type == 0) return 0;              /* type 0 = player */
    if (c->x <= 0 || c->x > 65534) return 0;  /* 65535 = fora de vista */
    if (c->y <= 0 || c->y > 65534) return 0;
    if (c->z > 15) return 0;
    if (c->hp > 100) return 0;
    return 1;
}

static int creature_read(uint64_t va, creature_t *c)
{
    uint8_t raw[0x200];
    if (!mem_read(va, raw, sizeof raw)) return 0;
    const entity_layout_t *L = &g_layout;
    memset(c, 0, sizeof *c);
    memcpy(&c->x, raw + L->pos, 4);
    memcpy(&c->y, raw + L->pos + 4, 4);
    c->z = raw[L->pos + 8];
    memcpy(&c->id, raw + L->id, 4);
    memcpy(c->name, raw + L->name, 32);
    c->name[32] = 0;
    c->hp = raw[L->hp];
    c->type = raw[L->type];
    return 1;
}

/* Acha o control block de cada criatura.
/* Acha o control block de cada criatura.
 *
 * POR QUE EXISTE: o handler de attack recebe `&shared_ptr<Monster>` e DESTROI
 * a copia (chama o destrutor em exe+0x784be0+0x1ab). O ctrl tem que ser o
 * control block DA PROPRIA CRIATURA.
 *
 * Antes eu emprestava o do shared_ptr<Tile> do LocalPlayer (+0x9b0):
 *   - pode estar NULL (ficou NULL com o personagem parado — PID 9452)
 *   - e' de outro tipo; o destrutor rodava sobre um objeto alheio
 *
 * DESCOBERTA (2026-11-10, PID 9452): `make_shared` coloca o control block
 * IMEDIATAMENTE ANTES do objeto, a -0x10. Confirmado em 14 de 14:
 *
 *     cb 0x2a593adb090  ->  criatura 0x2a593adb0a0   (delta +0x10)
 *     cb 0x2a593adbc20  ->  criatura 0x2a593adbc30   (delta +0x10)
 *     cb 0x2a5b4222390  ->  criatura 0x2a5b42223a0   (delta +0x10)
 *     ... 14 de 14 com o mesmo delta
 *
 * Entao nao precisa varrer memoria: `cb = criatura - 0x10`. Uma leitura por
 * criatura para VALIDAR (a vtable do cb e' ?$_Ref_count_obj2@VMonster@@@std
 * e o +0x18 aponta de volta para a criatura). Se nao validar, fica 0 e o
 * attack recusa em vez de corromper. */
static void resolve_creature_cbs(const uint64_t *vas, int count)
{
    static uint64_t cbVtCache = 0;
    if (!count) return;
    uint64_t base = module_base_for_chain();
    if (!base) return;
    if (!cbVtCache) {
        cbVtCache = resolve_vtable_by_rtti(base, "?$_Ref_count_obj2@VMonster@@@std");
        if (cbVtCache)
            log_line("control block de Monster: rva 0x%llx",
                     (unsigned long long)(cbVtCache - base));
    }
    uint64_t cbVt = cbVtCache;

    int ok = 0;
    for (int i = 0; i < count; i++) {
        g_creatureCb[i] = 0;
        if (!vas[i]) continue;
        uint64_t cb = vas[i] - 0x10;
        uint8_t raw[0x20];
        if (!mem_read(cb, raw, sizeof raw)) continue;
        uint64_t vt = 0, back = 0;
        memcpy(&vt, raw, 8);
        memcpy(&back, raw + 0x18, 8);
        if (cbVt && vt != cbVt) continue;    /* nao e' control block de Monster */
        if (back != vas[i]) continue;         /* nao aponta de volta pra criatura */
        g_creatureCb[i] = cb;
        ok++;
    }
    log_line("control blocks: %d/%d criaturas casadas (criatura-0x10)", ok, count);
}

/* Varre a memoria por instancias do vtable de Monster.
/* Rele HP/posicao das criaturas JA CONHECIDAS, pelo VA guardado.
 *
 * POR QUE EXISTE (medido 2026-11-12)
 * ----------------------------------
 * `scan_creatures()` varre os 0x62D8000 bytes do processo e roda a cada
 * SCAN_INTERVAL_MS = 8 s. `tools/route-cycle.cjs` ataca e observa o HP por
 * 6 s. Ou seja: dentro da janela de observacao o HP publicado NUNCA e'
 * relido — `hpAfter` fica igual a `hpBefore` e o relatorio diz "0 ataques
 * com efeito", mesmo quando o handler aplicou dano (medido: `devolveu 13`
 * e o alvo morreu).
 *
 * Isto aqui e' o barato: uma leitura de ~0x120 B por criatura no VA que ja'
 * temos. Nao descobre criatura nova nem remove as que morreram — para isso
 * continua o scan completo. So' mantem HP/pos atuais.
 *
 * @param force  releitura imediata (chamado depois de um attack aceito)
 */
static void refresh_creature_stats(int force)
{
    static DWORD lastAt = 0;
    /* Cadencia: no maximo a cada 100 ms, ou imediatamente com force=1.
     * O canal de observacao roda a ate' 50 Hz; sem o limite, isso viraria
     * 64 leituras por telemetria e o custo superaria o do scan. */
    DWORD now = GetTickCount();
    if (!force && lastAt && (DWORD)(now - lastAt) < 100) return;
    lastAt = now;

    int count = g_creatureCount;
    if (count <= 0) return;

    for (int i = 0; i < count && i < MAX_CREATURES; i++) {
        uint64_t va = g_creatureVa[i];
        if (!va) continue;
        creature_t c;
        /* creature_read valida memoria; se o VA morreu (criatura sumiu), o
         * leitor falha e mantemos o ultimo valor conhecido. Remover da lista
         * e' trabalho do scan completo, que roda com a varredura correta. */
        if (!creature_read(va, &c)) continue;
        if (!creature_is_valid(&c)) continue;
        if (c.id != g_creatures[i].id) continue;   /* VA reciclado: deixa pro scan */
        g_creatures[i].hp = c.hp;
        g_creatures[i].x = c.x;
        g_creatures[i].y = c.y;
        g_creatures[i].z = c.z;

        /* BUG MEDIDO (2026-11-13): `g_ownSummon` ficava so' com o valor do
         * ultimo scan completo (8 s). O proprio Pokemon ANDA junto com o
         * jogador, entao em 8 s ele acumula dezenas de tiles de defasagem —
         * medido 26 tiles de erro. Ele e' quem executa o golpe (origem do
         * ataque e do combo), logo telemetria com ownPokemon velho faz o
         * consumidor calcular distancia errada e concluir "fora de alcance"
         * quando o alvo esta' do lado.
         *
         * Aqui a lista `g_creatures[]` JA' foi relida para este id; basta
         * espelhar no g_ownSummon quando for o mesmo id. */
        if (g_haveOwnSummon && g_ownSummon.id == g_creatures[i].id) {
            g_ownSummon.hp = g_creatures[i].hp;
            g_ownSummon.x = g_creatures[i].x;
            g_ownSummon.y = g_creatures[i].y;
            g_ownSummon.z = g_creatures[i].z;
        }
    }
}

/* Varre a memoria por instancias do vtable de Monster.
 *
 * Escreve num buffer LOCAL e so' publica no global no fim. Zerar o global no
 * inicio (versao anterior) abria uma janela em que build_telemetry lia
 * g_creatureCount=0 mesmo com criaturas na tela — a varredura leva ~1 s e o
 * telemetry e' montado no meio dela. Foi o bug de "5 criaturas depois 0". */
static void scan_creatures(void)
{
    static creature_t found[MAX_CREATURES];
    static uint64_t foundVa[MAX_CREATURES];
    int foundCount = 0;
    creature_t foundOwn;
    int haveOwn = 0;
    memset(&foundOwn, 0, sizeof foundOwn);

    uint64_t vt = resolve_monster_vtable();
    if (!vt) return;
    uint64_t base = module_base_for_chain();
    if (!base) return;

    const uint64_t limit = 0x7FFFFFFFFFFFULL;
    uint64_t addr = 0x10000;
    uint8_t *buf = (uint8_t *)malloc(0x100000);
    if (!buf) return;
    HANDLE queryProc = g_inProcess ? GetCurrentProcess() : g_proc;
    if (!queryProc) { free(buf); return; }

    while (addr < limit) {
        if (stop_signaled()) { free(buf); return; }
        MEMORY_BASIC_INFORMATION mbi;
        if (!VirtualQueryEx(queryProc, (LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) break;
        uint64_t rbase = (uint64_t)(uintptr_t)mbi.BaseAddress;
        uint64_t size = (uint64_t)mbi.RegionSize;
        int readable = (mbi.State == MEM_COMMIT) &&
                       (mbi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                                       PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                       PAGE_EXECUTE_WRITECOPY)) &&
                       !(mbi.Protect & PAGE_GUARD);
        if (readable) {
            for (uint64_t off = 0; off < size; off += 0x100000) {
                if (stop_signaled()) { free(buf); return; }
                size_t chunk = (size_t)((size - off) < 0x100000 ? (size - off) : 0x100000);
                SIZE_T got = 0;
                if (g_inProcess) {
                    got = chunk;
                    memcpy(buf, (const void *)(uintptr_t)(rbase + off), chunk);
                } else if (!ReadProcessMemory(g_proc, (LPCVOID)(uintptr_t)(rbase + off),
                                              buf, chunk, &got)) {
                    continue;
                }
                if (got < 0x200) continue;
                for (size_t i = 0; i + 0x200 <= got; i += 8) {
                    uint64_t cand = 0;
                    memcpy(&cand, buf + i, 8);
                    if (cand != vt) continue;
                    creature_t c;
                    if (!creature_read(rbase + off + i, &c)) continue;
                    if (!creature_is_valid(&c)) continue;
                    /* Aliado (type==3) NAO entra na lista de alvos. Ele segue
                     * o jogador e nao deve ser atacado. Vai para o slot
                     * proprio, que alimenta ownSummonId/pokemonName. */
                    if (c.type == CREATURE_TYPE_OWN) {
                        /* O aliado alimenta ownSummonId/pokemonName, MAS tambem
                         * entra na lista de criaturas: native-session.cjs
                         * localiza o proprio Pokemon por
                         * `creatures.filter(r => r.creatureType === 3)`.
                         * Se eu o removesse da lista, ownPokemon ficaria
                         * sempre null e o CombatEngine usaria a posicao do
                         * jogador como centro do lure.
                         *
                         * `canAttack` sai false (type != 1), entao o engine
                         * nunca escolhe o aliado como alvo. */
                        foundOwn = c; haveOwn = 1;
                    }
                    if (foundCount >= MAX_CREATURES) continue;
                    int dup = 0;
                    for (int k = 0; k < foundCount; k++) {
                        if (found[k].id == c.id) { dup = 1; break; }
                    }
                    if (dup) continue;
                    foundVa[foundCount] = rbase + off + i;
                    found[foundCount++] = c;
                }
            }
        }
        if (rbase + size <= addr) break;
        addr = rbase + size;
    }
    free(buf);

    /* corpos: selvagem que sumiu da varredura (ou veio com hp 0) vira
     * candidato de captura no ultimo tile conhecido. Nao depende de lista de
     * itens, que este build nao expoe. */
    for (int i = 0; i < g_creatureCount; i++) {
        if (g_creatures[i].type != CREATURE_TYPE_WILD) continue;
        int still = 0;
        for (int k = 0; k < foundCount; k++)
            if (found[k].id == g_creatures[i].id) { still = 1; break; }
        if (!still) corpse_record(g_creatures[i].id, g_creatures[i].x,
                                  g_creatures[i].y, g_creatures[i].z);
    }
    for (int k = 0; k < foundCount; k++)
        if (found[k].type == CREATURE_TYPE_WILD && found[k].hp == 0)
            corpse_record(found[k].id, found[k].x, found[k].y, found[k].z);

    /* publica de forma atomica: atualiza o global so' quando terminou */
    if (foundCount > 0) {
        memcpy(g_creatures, found, sizeof(creature_t) * (size_t)foundCount);
        memcpy(g_creatureVa, foundVa, sizeof(uint64_t) * (size_t)foundCount);
        InterlockedExchange((volatile LONG *)&g_creatureCount, foundCount);
        resolve_creature_cbs(foundVa, foundCount);
    } else {
        /* varredura sem resultado NAO apaga a lista anterior: pode ser
         * transicao de mapa ou leitura parcial. Zerar aqui fazia o telemetry
         * piscar entre 5 e 0. */
    }

    /* aliado: so' atualiza se apareceu nesta varredura */
    if (haveOwn) {
        g_ownSummon = foundOwn;
        InterlockedExchange((volatile LONG *)&g_haveOwnSummon, 1);
    }
    /* Contagem por tipo, para o log nao mentir.
     *
     * CONVENCAO OTClient (medida no build 48c41bd4, 2026-11-10):
     *   0 = player   1 = monster (selvagem)   2 = NPC
     *   3 = summon proprio   4 = summon de outro jogador
     *
     * O log antigo dizia "%d selvagens" usando foundCount — que conta TODAS
     * as entidades. Resultado: "5 selvagens" quando eram 5 summons de outros
     * jogadores e ZERO selvagens. Isso induziu a suspeita de que canAttack
     * (type==1) estava errado; nao estava. Medido: Dugtrio=3 (nosso),
     * Gengar/Gardevoir/Abra=4 (de outros), nenhum =1. */
    int nWild = 0, nOwn = 0, nOtherSummon = 0, nPlayer = 0;
    for (int k = 0; k < foundCount; k++) {
        switch (found[k].type) {
        case CREATURE_TYPE_WILD: nWild++; break;
        case CREATURE_TYPE_OWN:  nOwn++;  break;
        case 4:                  nOtherSummon++; break;
        case 0:                  nPlayer++; break;
        default: break;
        }
    }
    log_line("scan_creatures: %d selvagem(ns), %d summon proprio, "
             "%d summon de outro, %d player(s) [total %d], aliado=%s",
             nWild, nOwn, nOtherSummon, nPlayer, foundCount,
             haveOwn ? g_ownSummon.name : "nenhum");
}

/* escapa string para JSON (aspas, barra, controle) e trunca */
static void json_escape(char *dst, size_t cap, const char *src)
{
    size_t o = 0;
    for (size_t i = 0; src[i] && o + 7 < cap; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '"' || c == '\\') { dst[o++] = '\\'; dst[o++] = (char)c; }
        else if (c < 0x20) { o += (size_t)snprintf(dst + o, cap - o, "\\u%04x", c); }
        else dst[o++] = (char)c;
    }
    dst[o] = 0;
}

/* conta quantas criaturas cabem no orcamento de bytes do buffer */
static int creatures_json(char *dst, size_t cap)
{
    size_t o = 0;
    int n = 0;
    o += (size_t)snprintf(dst + o, cap - o, "[");
    for (int i = 0; i < g_creatureCount && o + 256 < cap; i++) {
        const creature_t *c = &g_creatures[i];
        char esc[80];
        json_escape(esc, sizeof esc, c->name);
        o += (size_t)snprintf(dst + o, cap - o,
            "%s{\"id\":%u,\"name\":\"%s\",\"type\":%u,\"healthPercent\":%u,"
            "\"canAttack\":%s,\"pos\":{\"x\":%d,\"y\":%d,\"z\":%d}}",
            n ? "," : "", c->id, esc, c->type, c->hp,
            (c->type == CREATURE_TYPE_WILD && c->hp > 0) ? "true" : "false",
            c->x, c->y, (int)c->z);
        n++;
    }
    snprintf(dst + o, cap - o, "]");
    return n;
}

/* corpos observados, no formato que o consumidor de captura le:
 * {"id","corpseId","stack","pos"}. `stack` fixo em 1 (corpo nao empilha). */
static int corpses_json(char *dst, size_t cap)
{
    corpse_forget_expired();
    size_t o = 0;
    int n = 0;
    o += (size_t)snprintf(dst + o, cap - o, "[");
    for (int i = 0; i < g_corpseCount && o + 128 < cap; i++) {
        const corpse_t *c = &g_corpses[i];
        o += (size_t)snprintf(dst + o, cap - o,
            "%s{\"id\":%u,\"corpseId\":%u,\"stack\":1,\"container\":false,"
            "\"pos\":{\"x\":%d,\"y\":%d,\"z\":%d}}",
            n ? "," : "", c->id, c->id, c->x, c->y, (int)c->z);
        n++;
    }
    snprintf(dst + o, cap - o, "]");
    return n;
}
static size_t build_telemetry(uint8_t *out, size_t cap, uint32_t tick)
{
    entity_t p;
    /* FONTE UNICA: refresh_state() resolve o player e publica posicao nas
     * globais. build_telemetry NAO le a entidade por conta propria — fazer
     * isso permitia publicar posicao de um VA stale sem que refresh_state
     * soubesse. Ver o stale-check em refresh_state(). */
    int havePlayer = g_playerVa && entity_read(g_playerVa, &p);
    int32_t px = g_havePos ? g_posX : (havePlayer ? p.x : 0);
    int32_t py = g_havePos ? g_posY : (havePlayer ? p.y : 0);
    int32_t pz = g_havePos ? g_posZ : (havePlayer ? p.z : 0);
    int hp = havePlayer ? p.hp : 0;
    const char *name = havePlayer && p.name[0] ? p.name : (g_playerKnown ? g_playerName : "");

    /* buffer separado para criaturas: ate 64 * ~120 B = ~8 KB */
    char *creatures = (char *)malloc(16384);
    if (!creatures) return 0;
    /* Antes de serializar: relê HP/pos das criaturas ja' conhecidas.
     * Sem isso o consumidor ve' o HP do ultimo scan completo (8 s) e
     * mede "ataque sem efeito" mesmo com dano aplicado. Ver o comentario
     * em refresh_creature_stats(). Custo: ~12 B * N criaturas. */
    refresh_creature_stats(0);
    creatures_json(creatures, 16384);
    char items[8192];
    corpses_json(items, sizeof items);

    /* Aliado invocado (type==3): publica id e nome. `ownSummonId` e
     * `pokemonName` sao campos do contrato de telemetria; sem eles o motor de
     * combate nao distingue o proprio Pokemon de um selvagem. */
    char ownName[80] = "";
    char ownIdJson[40] = "";
    char ownPokemonJson[256] = "";
    if (g_haveOwnSummon && g_ownSummon.name[0]) {
        json_escape(ownName, sizeof ownName, g_ownSummon.name);
        snprintf(ownIdJson, sizeof ownIdJson, "\"ownSummonId\":%u,", g_ownSummon.id);
        /* ownPokemon completo: o CombatEngine usa ownPokemon.id e
         * ownPokemon.pos como centro do perfect lure. Publicar o objeto
         * evita depender do filtro por creatureType==3 do native-session. */
        snprintf(ownPokemonJson, sizeof ownPokemonJson,
                 "\"ownPokemon\":{\"id\":%u,\"name\":\"%s\",\"healthPercent\":%u,"
                 "\"pos\":{\"x\":%d,\"y\":%d,\"z\":%d}},",
                 g_ownSummon.id, ownName, g_ownSummon.hp,
                 g_ownSummon.x, g_ownSummon.y, (int)g_ownSummon.z);
    }
    if (g_haveOwnSummon && g_ownSummon.name[0]) {
        json_escape(ownName, sizeof ownName, g_ownSummon.name);
        snprintf(ownIdJson, sizeof ownIdJson, "\"ownSummonId\":%u,", g_ownSummon.id);
    }

    /* runtimeReady: "posso agir?" — lido do MESMO gate que o ataque exige.
     *
     * MEDIDO (2026-11-12, adendo 6): 54 walks retornaram "dir=N na thread do
     * jogo" e ZERO tiles foram andados. O jogo estava no menu:
     *
     *     runtime gate [rt+0x2668] = 0
     *     runtime alvo [rt+0x2528] = 0x0
     *     global LocalPlayer       = 0x0
     *
     * E nenhum dos sinais que ja' publicamos detecta isso:
     *   `healthPercent` = 100 no menu tambem;
     *   `position`      = vem do vtable-scan, que acha a instancia mesmo sem
     *                     mapa ativo;
     *   `playerName`    = idem.
     *
     * O gate e' o unico criterio que separa "no mundo" de "no menu". Custo:
     * uma leitura de 1 byte por telemetria. Sem ele, TODO consumidor
     * (route-cycle, walker, bot-runtime) tem o mesmo falso positivo e gasta
     * comandos em um personagem que nao existe no mapa. */
    uint64_t rtBase = module_base_for_chain();
    uint8_t rtGate = 0;
    if (rtBase) mem_read(rtBase + RUNTIME_RVA + 0x2668, &rtGate, 1);

    int n = snprintf((char *)out, cap,
        "{\"schema\":2,\"nativeVerified\":true,\"pulseVersion\":3,"
        "\"tick\":%u,\"playerId\":%u,\"fightMode\":0,\"chaseMode\":0,\"clockMs\":%u,"
        "\"position\":{\"x\":%d,\"y\":%d,\"z\":%d},"
        "\"playerName\":\"%s\",\"activeSlot\":0,\"moves\":[],\"nativeSequence\":[],"
        "%s%s\"pokemonName\":\"%s\",\"comboPokemonName\":\"\","
        "\"conditionEvents\":false,\"conditionsKnown\":false,\"conditions\":[],"
        "\"roster\":[],\"creatures\":%s,\"items\":%s,\"tiles\":[],"
        "\"clientPid\":%d,\"healthPercent\":%d,\"runtimeReady\":%s}",
        tick, havePlayer ? p.id : 0u, GetTickCount(),
        px, py, pz, name, ownIdJson, ownPokemonJson, ownName, creatures, items,
        (int)g_targetPid, hp, rtGate ? "true" : "false");
    free(creatures);
    if (n < 0) return 0;
    if ((size_t)n >= cap) return 0;
    return (size_t)n;
}

/* -------------------------------------------------------------- transporte */
static int write_all(HANDLE pipe, const uint8_t *data, size_t len)
{
    size_t done = 0;
    while (done < len) {
        DWORD written = 0;
        if (!WriteFile(pipe, data + done, (DWORD)(len - done), &written, NULL) || written == 0)
            return 0;
        done += written;
    }
    return 1;
}

static int send_frame(HANDLE pipe, uint32_t kind, const uint8_t *payload, size_t len)
{
    uint8_t header[8];
    header[0] = (uint8_t)(len & 0xff);
    header[1] = (uint8_t)((len >> 8) & 0xff);
    header[2] = (uint8_t)((len >> 16) & 0xff);
    header[3] = (uint8_t)((len >> 24) & 0xff);
    header[4] = (uint8_t)(kind & 0xff);
    header[5] = (uint8_t)((kind >> 8) & 0xff);
    header[6] = (uint8_t)((kind >> 16) & 0xff);
    header[7] = (uint8_t)((kind >> 24) & 0xff);
    if (!write_all(pipe, header, 8)) return 0;
    if (len == 0) return 1;
    return write_all(pipe, payload, len);
}

/* ------------------------------------------------------------- execucao */
/* Comandos que nao exigem chamar funcao do jogo: teclas. O alvo recebe
 * PostMessageW da propria janela do jogo. attack/follow/useWith dependem de
 * RVA nao recuperado - respondem status 3 ("Funcoes do jogo indisponiveis"),
 * que e o codigo do proprio protocolo. Nao inventamos execucao. */
static DWORD g_enumPid = 0;
static HWND g_enumHwnd = NULL;

static BOOL CALLBACK enum_pick(HWND hwnd, LPARAM lparam)
{
    (void)lparam;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != g_enumPid || !IsWindowVisible(hwnd)) return TRUE;
    char title[256];
    if (!GetWindowTextA(hwnd, title, (int)sizeof title) || !title[0]) return TRUE;
    if (_strnicmp(title, "PokeAlliance", 12) != 0) return TRUE;
    /* NAO exigir GetClientRect > 0.
     *
     * Janela minimizada tem GetClientRect = 0x0 e GetWindowRect em
     * (-32000,-32000). O caminho NATIVO (Game::walk na thread do jogo) nao
     * precisa de area de cliente: so' do HWND e da thread dona. Exigir
     * cliente valido fazia locate_window devolver NULL e o walk nativo nem
     * era tentado — medido em 2026-11-10 com o jogo minimizado.
     *
     * O caminho de TECLADO continua precisando de janela real; ele checa
     * foco depois e falha com STATUS_NO_FOREGROUND, o que e' correto. */
    g_enumHwnd = hwnd;
    return FALSE;
}

static HWND locate_window(void)
{
    g_enumPid = (DWORD)g_targetPid;
    g_enumHwnd = NULL;
    EnumWindows(enum_pick, 0);
    return g_enumHwnd;
}

static int key_code(const char *key, size_t len, uint16_t *vk)
{
    if (len >= 2 && (key[0] == 'f' || key[0] == 'F')) {
        int n = 0;
        for (size_t i = 1; i < len; i++) {
            if (key[i] < '0' || key[i] > '9') return 0;
            n = n * 10 + (key[i] - '0');
        }
        if (n >= 1 && n <= 12) { *vk = (uint16_t)(0x6F + n); return 1; }
        return 0;
    }
    if (len == 1 && ((key[0] >= 'a' && key[0] <= 'z') || (key[0] >= 'A' && key[0] <= 'Z'))) {
        *vk = (uint16_t)toupper(key[0]);
        return 1;
    }
    if (len == 1 && key[0] >= '0' && key[0] <= '9') { *vk = (uint16_t)key[0]; return 1; }
    if (len == 4 && _strnicmp(key, "left", 4) == 0) { *vk = 0x25; return 1; }
    if (len == 5 && _strnicmp(key, "right", 5) == 0) { *vk = 0x27; return 1; }
    if (len == 2 && _strnicmp(key, "up", 2) == 0) { *vk = 0x26; return 1; }
    if (len == 4 && _strnicmp(key, "down", 4) == 0) { *vk = 0x28; return 1; }
    return 0;
}

/* Combina tecla + modificadores, no formato da config do Shiba.
 *
 * A config real usa: `hoenn.potionHotkey = "Alt+f"`, `medicineHotkey = "E"`,
 * `walker.guildDailyTicketHotkey`. O parser simples (`key_code`) so' cobre
 * tecla unica e F1..F12, entao `"Alt+f"` era recusado.
 *
 * Formato aceito: [ctrl+][shift+][alt+]TECLA, case-insensitive, nessa ordem
 * ou em qualquer ordem (varremos os prefixos um a um). TECLA usa `key_code`.
 *
 * Saida: `vk` da tecla final e `mods` bitmask (MOD_ALT | MOD_CONTROL | MOD_SHIFT).
 * Devolve 0 se a tecla nao for reconhecida. */
#define KEYMOD_ALT     1
#define KEYMOD_CTRL    2
#define KEYMOD_SHIFT   4

/* tap_key_ex e' definida mais abaixo; tap_key_with_mods depende dela. */
static int tap_key_ex(HWND hwnd, uint16_t vk, uint8_t scan, int extended);

static int parse_key_spec(const char *spec, size_t len, uint16_t *vk, int *mods)
{
    int m = 0;
    size_t i = 0;
    /* prefixos em qualquer ordem */
    for (;;) {
        size_t rest = len - i;
        if (rest > 4 && _strnicmp(spec + i, "ctrl+", 5) == 0) { m |= KEYMOD_CTRL; i += 5; continue; }
        if (rest > 4 && _strnicmp(spec + i, "control+", 8) == 0 && rest >= 8) { m |= KEYMOD_CTRL; i += 8; continue; }
        if (rest > 5 && _strnicmp(spec + i, "shift+", 6) == 0) { m |= KEYMOD_SHIFT; i += 6; continue; }
        if (rest > 4 && _strnicmp(spec + i, "alt+", 4) == 0) { m |= KEYMOD_ALT; i += 4; continue; }
        break;
    }
    if (i >= len) return 0;
    if (!key_code(spec + i, len - i, vk)) return 0;
    *mods = m;
    return 1;
}

/* Envia tecla com modificadores: pressiona mods, a tecla, solta tudo.
 *
 * Ordem importa para o jogo ver a combinacao: mods down -> key down -> key up
 * -> mods up, com uma pausa minima entre key down e key up. */
static int tap_key_with_mods(HWND hwnd, uint16_t vk, int mods)
{
    static const struct { int bit; uint16_t vk; uint8_t scan; } MODS[] = {
        { KEYMOD_CTRL,  VK_CONTROL, 0x1D },
        { KEYMOD_SHIFT, VK_SHIFT,   0x2A },
        { KEYMOD_ALT,   VK_MENU,    0x38 },
    };
    uint8_t scan = (uint8_t)MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    int extended = (vk >= VK_PRIOR && vk <= VK_DOWN) || vk == VK_INSERT
                || vk == VK_DELETE || vk == VK_HOME || vk == VK_END;

    for (size_t i = 0; i < sizeof MODS / sizeof MODS[0]; i++) {
        if (mods & MODS[i].bit) {
            LPARAM d = (LPARAM)(1 | ((LPARAM)MODS[i].scan << 16));
            if (!PostMessageA(hwnd, WM_KEYDOWN, MODS[i].vk, d)) return 0;
        }
    }
    int ok = tap_key_ex(hwnd, vk, scan, extended);
    for (size_t i = sizeof MODS / sizeof MODS[0]; i-- > 0;) {
        if (mods & MODS[i].bit) {
            LPARAM u = (LPARAM)(1 | ((LPARAM)MODS[i].scan << 16)
                       | (LPARAM)(1u << 30) | (LPARAM)(1u << 31));
            PostMessageA(hwnd, WM_KEYUP, MODS[i].vk, u);
        }
    }
    return ok;
}

/* Envio de tecla por PostMessage.
 *
 * `scan` e `extended` sao EXPLICITOS, nao derivados de MapVirtualKeyA:
 * as setas usam os scan codes 0x48/0x4D/0x50/0x4B com o bit de extended
 * (1 << 24) ligado. Foi assim que tools/walker_input.py movimentou o cliente
 * em 2026-10-29 e e' o formato que o DirectInput/raw do jogo espera. Sem o
 * bit extended o PostMessage e' aceito mas o jogo ignora — medido em
 * 2026-11-05 10:48:56 (status 0, posicao inalterada). */
static int tap_key_ex(HWND hwnd, uint16_t vk, uint8_t scan, int extended)
{
    LPARAM base = (LPARAM)(1 | ((LPARAM)scan << 16));
    if (extended) base |= (LPARAM)(1u << 24);
    LPARAM down = base;
    LPARAM up = base | (LPARAM)(1u << 30) | (LPARAM)(1u << 31);
    if (!PostMessageA(hwnd, WM_KEYDOWN, vk, down)) return 0;
    Sleep(15);
    if (!PostMessageA(hwnd, WM_KEYUP, vk, up)) return 0;
    return 1;
}

static int tap_key(HWND hwnd, uint16_t vk)
{    uint32_t scan = MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    if (!scan || scan > 0xFF) return 0;
    /* Teclas de navegacao exigem o bit extended. */
    int extended = (vk >= VK_PRIOR && vk <= VK_DOWN) || vk == VK_INSERT
                || vk == VK_DELETE || vk == VK_HOME || vk == VK_END;
    return tap_key_ex(hwnd, vk, (uint8_t)scan, extended);
}

/* Clique DIREITO no cliente, em coordenadas de cliente (mesmo par de mensagens
 * que o atuador de teclado usa para atacar). Opcional: a captura depende do
 * corpo estar sob o cursor antes da tecla da bola. */
static int click_client(HWND hwnd, int x, int y, int right)
{
    if (x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF) return 0;
    LPARAM lp = (LPARAM)(uint16_t)x | ((LPARAM)(uint16_t)y << 16);
    UINT down = right ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
    UINT up = right ? WM_RBUTTONUP : WM_LBUTTONUP;
    WPARAM downW = right ? 2 : 1;
    if (!PostMessageA(hwnd, down, downW, lp)) return 0;
    Sleep(15);
    if (!PostMessageA(hwnd, up, 0, lp)) return 0;
    return 1;
}

/* Executa o atalho do slot N da action bar (20 slots, barra central inferior). */
static int click_action_slot(HWND hwnd, int slot)
{
    RECT rc;
    if (!GetClientRect(hwnd, &rc)) return 0;
    int w = rc.right - rc.left, h = rc.bottom - rc.top;
    if (w < 400 || h < 300 || slot < 1 || slot > 20) return 0;
    double step = 36.0 * ((double)w / 1920.0);
    if (step < 18.0) step = 18.0;
    int x = (int)((double)w / 2.0 + ((double)slot - 10.5) * step);
    int y = h - (int)(48.0 * ((double)h / 1009.0) < 26.0 ? 26.0 : 48.0 * ((double)h / 1009.0));
    return click_client(hwnd, x, y, 1);
}

/* Projeta um tile no cliente assumindo camera centrada no jogador. A escala
 * vem do viewport calibrado de 1920 px (72,36 px por tile). */
static int project_tile(HWND hwnd, int32_t dx, int32_t dy, int *outX, int *outY)
{
    RECT rc;
    if (!GetClientRect(hwnd, &rc)) return 0;
    int w = rc.right - rc.left, h = rc.bottom - rc.top;
    if (w < 200 || h < 200) return 0;
    double tile = 72.36 * ((double)w / 1920.0);
    *outX = (int)((double)w / 2.0 + (double)dx * tile);
    *outY = (int)((double)h * 0.40 + (double)dy * tile);
    return (*outX > 0 && *outX < w && *outY > 0 && *outY < h);
}

/* Envia texto para a janela por WM_CHAR.
 *
 * O cliente e' OTClient: o console de chat recebe WM_CHAR quando esta' aberto.
 * Um caractere por mensagem, com o lParam padrao de tecla fisica (repeat=1).
 *
 * MEDIDO (2026-11-10): o `!autocombo` tem handler DENTRO do binario — o jogo
 * compara o texto do chat com a string `!autocombo` em exe+0x44382b, pulando
 * 3 bytes de prefixo. Ou seja: o caminho e' mandar no chat, nao chamar funcao.
 *
 * So' ASCII imprimivel. Nao inventa acento nem caractere fora da faixa — se
 * vier, recusa em vez de mandar lixo no chat do jogador. */
static int tap_text(HWND hwnd, const char *text, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)text[i];
        if (c < 0x20 || c > 0x7e) return 0;
        if (!PostMessageA(hwnd, WM_CHAR, (WPARAM)c, (LPARAM)1)) return 0;
        Sleep(8);
    }
    return 1;
}

/* Abre o console de chat apertando Enter, digita, e confirma com Enter.
 *
 * O Enter de abertura so' funciona se a janela estiver em primeiro plano:
 * mesmo gate do walk/hotkey. Sem foco, recusa — nao ha caminho background
 * medido. */
static int send_chat_text(HWND hwnd, const char *text, size_t len)
{
    if (!tap_key(hwnd, VK_RETURN)) return 0;
    Sleep(120);
    if (!tap_text(hwnd, text, len)) {
        /* fecha o console que abrimos, para nao deixar o jogador com o chat
         * aberto por causa de uma falha nossa */
        tap_key(hwnd, VK_ESCAPE);
        return 0;
    }
    Sleep(60);
    if (!tap_key(hwnd, VK_RETURN)) return 0;
    return 1;
}

/* Politica de foco do executor.
 *
 * HISTORICO DO DEFEITO (medido e depois removido)
 * A versao anterior chamava, a CADA comando de caminhada:
 *
 *     ShowWindow(hwnd, SW_RESTORE);
 *     SetForegroundWindow(hwnd);
 *     BringWindowToTop(hwnd);
 *
 * `SW_RESTORE` nao e' "mostrar a janela": a documentacao diz que, se ela
 * estiver maximizada ou minimizada, o sistema a restaura ao tamanho e posicao
 * ORIGINAIS. Ou seja: quem tinha o jogo maximizado via a janela encolher a
 * cada passo, e quem estava usando outra aplicacao tinha o foco roubado.
 *
 * Isso foi interferencia nao autorizada do bot na area de trabalho do usuario.
 * Removido. O executor agora NAO altera estado de janela em nenhum caso:
 * nao chama ShowWindow, SetForegroundWindow, BringWindowToTop, AttachThreadInput
 * nem SetActiveWindow.
 *
 * MODOS (PKA_EXECUTOR_MODE)
 *   foreground (padrao) : exige a janela ja' em primeiro plano. Se nao estiver,
 *                         devolve STATUS_NO_FOREGROUND e NAO envia tecla.
 *   background          : nao tenta foco e nao verifica; apenas posta a mensagem.
 *                         NAO VALIDADO NO CLIENTE — pode nao produzir efeito,
 *                         porque o cliente aparentemente ignora PostMessage em
 *                         background. Marcado como experimental.
 */
#define STATUS_OK 0
#define STATUS_BAD_COMMAND 1
#define STATUS_SEND_FAILED 2
#define STATUS_NO_WINDOW 3
#define STATUS_UNSUPPORTED 4
#define STATUS_NO_FOREGROUND 5
#define STATUS_BACKGROUND_UNSUPPORTED 6

/*
 * MODOS DE EXECUCAO — estado real, medido
 * =======================================
 *
 * foreground (unico suportado)
 *   Exige a janela ja' em primeiro plano. Recusa se nao estiver.
 *   Nao captura foco, nao restaura, nao reordena. VALIDADO NO CLIENTE
 *   em 2026-11-05 19:10Z (teste A) e 2026-11-06 01:40Z (teste B).
 *
 * background — NAO SUPORTADO
 *   A versao anterior aceitava PKA_EXECUTOR_MODE=background e simplesmente
 *   pulava o gate de foco, postando a mensagem mesmo assim. Isso e' um modo
 *   "nominal": nao move o personagem.
 *
 *   MEDIDO em 2026-11-05 12:44, no cliente real:
 *     - com outra janela em primeiro plano, 4 direcoes postadas -> 0 movimento
 *     - apos trazer o jogo para frente, as MESMAS 4 direcoes -> 4 movimentos
 *       com delta exato (0,-1) (0,+1) (+1,0) (-1,0)
 *   Ou seja: o cliente ignora WM_KEYDOWN quando nao esta' em primeiro plano.
 *
 *   A tentativa de aceitar o modo sem verificar foco foi REMOVIDA. Pedir
 *   background agora devolve STATUS_BACKGROUND_UNSUPPORTED (6), explicitamente,
 *   em vez de fingir sucesso.
 *
 *   Nota de arquitetura: o cliente e' um OTClient (strings
 *   `LocalPlayer::walk server walk`, `preWalk`, `cancelWalk`, `.otui`,
 *   RTTI `LuaObject`). O movimento real nesta engine e' uma chamada nativa
 *   `LocalPlayer::walk(dir)` / envio de `server walk`, nao um evento de teclado.
 *   Um caminho background legitimo passaria por essa funcao interna ou por
 *   um canal do proprio cliente — nenhum dos dois esta estabelecido. Ver
 *   `docs/BACKGROUND_EXECUTOR.md`.
 */
static int executor_mode_background(void)
{
    const char *mode = getenv("PKA_EXECUTOR_MODE");
    return mode && _stricmp(mode, "background") == 0;
}

/* Nao age: so' informa se pode enviar. NUNCA muda o foco.
 * Retorna 1 = pode enviar; 0 = nao enviar. */
static int require_foreground(HWND hwnd)
{
    /* Background nao e' suportado: recusa em vez de pular o gate. */
    if (executor_mode_background()) return 0;
    return GetForegroundWindow() == hwnd ? 1 : 0;
}

static int background_requested(void)
{
    return executor_mode_background();
}

/* ===================== execucao na thread do jogo =====================
 *
 * PROBLEMA (declarado em docs/NATIVE_EXECUTOR_CONTRACT.md §4.2):
 * `session_thread` roda na thread do pipe. Chamar `Game::walk` dali troca o
 * par de shared_ptr `LocalPlayer+0x9a8/+0x9b0` SEM atomicidade de conjunto:
 *
 *   0x77f7a5  mov rax,[r8+0x9a8]    ; le antigo
 *   0x77f7b0  mov [r8+0x9a8],rcx    ; escreve novo
 *   0x77f7b7  mov rcx,[r8+0x9b0]    ; le antigo
 *   0x77f7c2  mov [r8+0x9b0],rdx    ; escreve novo
 *
 * Se o tick de render ler no meio, ve estado inconsistente.
 *
 * SOLUCAO: executar na thread dona da janela (a message loop), que e' a
 * mesma que o jogo usa para o seu proprio tick. Mecanismo escolhido:
 * `SetWindowsHookExW(WH_CALLWNDPROC)` com um hook que roda quando a janela
 * recebe QUALQUER mensagem — o hook e' chamado pela thread alvo, dentro do
 * message loop. O hook copia o pedido pendente e chama Game::walk dali.
 *
 * Por que CALLWNDPROC e nao QueueUserAPC: APC exige que a thread alvo esteja
 * em estado alertable (WaitForSingleObjectEx/ SleepEx). O message loop usa
 * GetMessage, que NAO e' alertable — o APC ficaria pendurado para sempre.
 *
 * Por que nao CreateRemoteThread: cria uma QUARTA thread, que nao e' a do
 * jogo. Nao resolve o problema de concorrencia; so' troca de thread.
 *
 * CUSTO: o hook e' global ao desktop (WH_CALLWNDPROC com dwThreadId!=0 e'
 * aceito, mas hooks global exigem a DLL em todo processo). Por isso uso
 * `dwThreadId = thread dona da janela` — fica restrito a uma thread, sem
 * injetar em mais nada.
 *
 * SEGURANCA: o hook devolve sempre CallNextHookEx, nunca engole mensagem.
 * Se o pedido pendente for 0, ele so' passa adiante. Nao ha caminho em que
 * o hook altere o fluxo de mensagens do jogo.
 */
typedef struct {
    /* Maquina de estados, nao flag binaria.
     *
     * BUG CORRIGIDO (revisao GPT, 2026-11-10): a versao anterior marcava
     * `done = 1` ANTES de chamar a funcao. O chamador via done==1 enquanto a
     * funcao ainda rodava, esperava 500 ms, desistia e devolvia FALSE — e
     * `execute_command` caia no fallback de teclado. Resultado possivel:
     *
     *   1. Game::walk chamada (demora 800 ms, ex. loading)
     *   2. caller desiste em 500 ms, manda TECLA -> segundo movimento
     *   3. a chamada nativa completa e move de novo
     *   = 2 tiles em vez de 1
     *
     * E ainda: o slot global era reutilizado enquanto o hook antigo rodava,
     * fazendo o pedido novo ler o `result` do pedido anterior.
     *
     * Agora: IDLE -> CLAIMED -> RUNNING -> COMPLETED, com `seq` monotonico
     * para o chamador conferir que o resultado e' do SEU pedido. */
    volatile LONG state;        /* GAME_CALL_* */
    volatile LONG seq;          /* contador monotonico do pedido */
    volatile LONG result;       /* 1 = funcao executou; 0 = falhou */
    volatile LONG ownerSeq;     /* qual seq o hook esta executando */
    uint32_t direction;
    /* Contexto para o despacho de TEXTO (talk/combo).
     *
     * O consumidor 0x785050 recebe `std::string*` em r9, nao `char*`: le
     * [r9+0x10] como tamanho e [r9+0x18] como capacidade, e usa [r9] como
     * ponteiro quando a capacidade passa de 0xf (layout MSVC de
     * std::string). Passar `const char*` ali faz o jogo ler lixo como
     * tamanho.
     *
     * Por isso o buffer vive aqui, no processo do jogo, e o hook monta a
     * struct std::string na PROPRIA PILHA da thread do jogo antes de chamar.
     * O bloco e' escrito pelo chamador (thread da sessao) antes de publicar
     * CLAIMED; a thread do jogo so' le. */
    volatile LONG textLen;      /* bytes validos em textBuf (0 = nao e' texto) */
    char textBuf[208];          /* ASCII; o consumidor copia no call */
    volatile LONG comboMode;    /* 1 = chamar o interpretador de !autocombo */
} game_call_t;

#define GAME_CALL_IDLE      0
#define GAME_CALL_CLAIMED   1   /* pedido publicado, hook ainda nao pegou */
#define GAME_CALL_RUNNING   2   /* hook pegou e esta dentro da funcao */
#define GAME_CALL_COMPLETED 3   /* funcao retornou */

static game_call_t g_gameCall;
static HHOOK g_hook = NULL;
static DWORD g_gameThreadId = 0;
/* Thread PERSISTENTE dona do hook.
 *
 * BUG ESTRUTURAL (medido 2026-11-12): o hook era instalado na thread que
 * atendia a conexao do pipe (`session_thread`), que e' efemera — uma por
 * conexao. Cada vez que a conexao fechava, a thread morria e o Windows
 * removia a entrada da cadeia de hooks. O log mostrou 80 TIDs distintos
 * instalando o hook e 72 "hook orfao ... reinstalando" no mesmo processo.
 *
 * O sintoma era cruel: o pedido era publicado (CLAIMED), a mensagem era
 * despachada (envios=7 ok=7), a callback rodava em OUTRAS 312 entradas — mas
 * nunca encontrava o pedido, porque rodava numa cadeia velha. `hook nao pegou
 * o pedido em 1000 ms` com `entradas=312`.
 *
 * Correcao: UMA thread dedicada, viva enquanto a DLL estiver carregada,
 * instala o hook e fica num message loop. Ela nunca fecha entre conexoes,
 * entao a cadeia nunca perde a entrada. */static uint64_t g_walkFn = 0;
/* Consumidor de texto nativo (talk/combo). 0 quando nao resolvido. */
static uint64_t g_textFn = 0;
/* Interpretador de "!autocombo" (exe+0x67fbf0). Separado do consumidor de
 * texto: assinatura diferente (so' rcx, std::string*) e comportamento
 * diferente (dispara a sequencia de skills em vez de falar no chat). */
static uint64_t g_comboInterp = 0;
/* Objeto passado em rcx. O consumidor recarrega de [0x39cb998], mas
 * passamos o valor real do global para nao depender do recarregamento. */
static uint64_t g_textCtx = 0;
/* Motivo pelo qual o hook NAO entregou o texto. Existe para o log nao mentir:
 * "hook nao pegou" e "recusamos antes de chamar" sao diagnosticos opostos —
 * o primeiro sugere problema de despacho, o segundo e' uma recusa nossa. */
#define TEXT_SKIP_NONE      0
#define TEXT_SKIP_TOO_LONG  1   /* > 15 bytes (reservado; nao mais usado) */
#define TEXT_SKIP_NO_PATH   2   /* resolve_text_path falhou */
static volatile LONG g_textSkipReason = TEXT_SKIP_NONE;

/* Buffer estatico para textos > 15 bytes (fora do SSO).
 *
 * A string passada ao consumidor pode apontar para ca' porque:
 *   1. o epilogo de 0x785050 destroi a string LOCAL dele, nunca a do
 *      chamador (ver o bloco no game_call_hook);
 *   2. o chamador de referencia libera a propria string depois do retorno,
 *      o que prova que 0x812240 nao retem o ponteiro.
 *
 * Nao ha malloc/free: nenhuma divergencia de CRT entre a nossa DLL (zig) e o
 * exe pode entrar na equacao. O buffer vive tanto quanto a DLL. */
static char g_textHeap[208];
static char *g_textPtr = NULL;

/* Quantas vezes a callback foi ENTRADA, independente do estado.
 *
 * WHY: "hook nao pegou o pedido" e "hook nunca rodou" sao diagnosticos
 * diferentes. Sem este contador, um SendMessageTimeout que retorna sucesso
 * (janela consumiu a mensagem) e um hook ausente da cadeia produzem o mesmo
 * log. Medido em 2026-11-10: envios=7 ok=7 e nenhuma execucao — o hook nao
 * estava na cadeia, a mensagem estava sendo entregue normalmente. */
static volatile LONG g_hookEntries = 0;

/* Thread que instalou o hook. Cadeias de hook sao mantidas por thread; quando
 * a thread que instalou termina, a entrada some. A sessao do pipe cria uma
 * thread por conexao, entao um hook instalado por ela morre junto e a proxima
 * conexao ve g_hook != NULL (stale) sem reinstalar nada. */
static DWORD g_hookOwnerTid = 0;

/* Handles/estado da thread persistente do hook (ver comentario em g_hook). */
static HANDLE g_hookThread = NULL;
static DWORD  g_hookThreadTid = 0;
/* Evento que a thread do hook espera para saber que ja' instalou (ou falhou). */
static HANDLE g_hookReadyEvent = NULL;
static volatile LONG g_hookInstallFailed = 0;
/* HWND alvo; a thread espera ele aparecer em vez de desistir. */
static HWND   g_targetHwnd = NULL;

/* Mensagem privada usada para acordar a thread do jogo.
 *
 * WHY NAO WM_NULL: WM_NULL (0) e' descartada pelo kernel antes do despacho
 * em varios caminhos; o hook CALLWNDPROC nao roda e o pedido morre no
 * timeout. Medido em 2026-11-10: 1 de 4 envios com WM_NULL disparava.
 * RegisterWindowMessage devolve um id na faixa 0xC000..0xFFFF, que atravessa
 * o despacho como qualquer mensagem de aplicacao. */
static UINT g_wakeMsg = 0;

/* roda na thread do jogo (dentro do message loop) */
static LRESULT CALLBACK game_call_hook(int code, WPARAM wParam, LPARAM lParam)
{
    InterlockedIncrement(&g_hookEntries);
    /* Instrumento: prova em QUAL thread a callback roda. Instalar um hook
     * thread-specific nao garante por si so que a callback execute na thread
     * alvo — isso precisa ser medido, nao assumido. */
    static DWORD loggedTid = 0;
    if (code >= 0) {
        /* CLAIM atomico: so' um pedido, e so' uma vez.
         * Se o estado nao for CLAIMED, nao ha nada para fazer. */
        LONG expect = GAME_CALL_CLAIMED;
        if (InterlockedCompareExchange(&g_gameCall.state, GAME_CALL_RUNNING, expect) == expect) {
            uint32_t dir = g_gameCall.direction;
            LONG mySeq = g_gameCall.seq;
            DWORD tid = GetCurrentThreadId();
            if (tid != loggedTid) {
                loggedTid = tid;
                log_line("walk nativo: hook rodou na thread %lu (alvo %lu) msg=0x%04x",
                         (unsigned long)tid, (unsigned long)g_gameThreadId, (unsigned)g_wakeMsg);
            }
            InterlockedExchange(&g_gameCall.ownerSeq, mySeq);
            LONG ok = 0;
            if (g_walkFn) {
                LONG textLen = g_gameCall.textLen;
                /* comboMode TEM PRIORIDADE sobre textLen: os dois ficam
                 * setados quando o combo roda (textLen=10 para o literal),
                 * entao checar textLen primeiro mandaria "!autocombo" para o
                 * CHAT em vez do interpretador. */
                if (g_gameCall.comboMode) {
                    /* CAMINHO DO INTERPRETADOR (exe+0x67fbf0).
                     * Assinatura: void interpretador(std::string *msg) — so rcx.
                     * O literal precisa ser exatamente "!autocombo" (10 bytes):
                     * o prologo faz `cmp r8,10` e `strncmp` e sai calado se
                     * nao bater. A sequencia de skills vem da config. */
                    typedef union { char buf[16]; char *ptr; } ci_u;
                    typedef struct { ci_u u; uint64_t size; uint64_t cap; } ci_str;
                    ci_str cs;
                    memset(&cs, 0, sizeof cs);
                    memcpy(cs.u.buf, "!autocombo", 10);
                    cs.size = 10;
                    cs.cap = 15;   /* SSO: buffer inline, nunca ponteiro */
                    typedef void (*combo_fn_t)(void *);
                    combo_fn_t cf = (combo_fn_t)(uintptr_t)g_walkFn;
                    cf(&cs);
                    ok = 1;
                } else if (textLen > 0 && textLen <= (LONG)sizeof g_gameCall.textBuf
                    && g_textFn) {
                    /* CAMINHO DE TEXTO (talk/combo) — roda na thread do jogo.
                     *
                     * Consumidor: 0x785050(textFn)(rcx, edx=1, r8d=0, r9=&string)
                     *
                     * rcx e' RECARREGADO dentro da funcao a partir de globais
                     * ([0x39cb998]); o valor de entrada nao e' usado no corpo
                     * observado. Ainda assim passamos o objeto real para nao
                     * depender disso.
                     *
                     * r9 aponta para um std::string montado AQUI, na pilha da
                     * thread do jogo. Layout MSVC x64 (32 bytes):
                     *   +0x00  union { char buf[16]; char* ptr; }
                     *   +0x10  size_t size
                     *   +0x18  size_t capacity
                     * Para size <= 15 usa o buffer interno; o chamador de
                     * referencia (0x680444) faz o mesmo caminho SSO.
                     *
                     * O consumidor COPIA o conteudo: no retorno em 0x785125
                     * ele destroi a propria string local. Nao retemos ponteiro
                     * para a nossa struct depois do retorno. */
                    /* Layout MSVC x64 de std::string (32 bytes):
                     *   +0x00  union { char buf[16]; char* ptr; }
                     *   +0x10  size_t size
                     *   +0x18  size_t capacity
                     * A union e' obrigatoria: o jogo le +0 como PONTEIRO
                     * quando capacity > 15 e como BUFFER quando <= 15. Usar
                     * sempre buf[] e escrever size/cap grandes faria o jogo
                     * interpretar os 8 primeiros bytes de texto como endereco. */
                    typedef union { char buf[16]; char *ptr; } ss_union;
                    typedef struct { ss_union u; uint64_t size; uint64_t cap; } sso_string;
                    sso_string s;
                    memset(&s, 0, sizeof s);
                    uint32_t n = (uint32_t)textLen;
                    if (n <= 15) {
                        memcpy(s.u.buf, g_gameCall.textBuf, n);
                        s.size = n;
                        s.cap = 15;
                    } else {
                        /* FORA DO SSO — resolvido SEM heap, e o motivo importa.
                         *
                         * MEU DIAGNOSTICO ANTERIOR ESTAVA ERRADO. Eu assumi que
                         * 0x785050 destruia a string do CHAMADOR no epilogo. O
                         * disasm ao vivo mostra o contrario:
                         *
                         *   0x7850e5  inicializa string VAZIA em [rsp+0x40], cap=15
                         *   0x78510d  [rsp+0x20] = rdi      <- a NOSSA string vira
                         *                                      o 5o argumento
                         *   0x785112  lea r9,[rsp+0x40]     <- r9 e' a local dele
                         *   0x785159  destructor so' se [rsp+0x58] > 0xf
                         *
                         * Ou seja: o destrutor do epilogo trata a string LOCAL
                         * DELE (a vazia), nunca a do chamador. O chamador de
                         * referencia (0x67fbf0) libera a propria string DEPOIS
                         * que 0x785050 retorna — o que prova, por construcao,
                         * que 0x812240 nao retem o ponteiro.
                         *
                         * Consequencia: nao preciso do alocador do jogo e nao
                         * preciso de heap nenhum. A string pode apontar para
                         * memoria ESTATICA desta DLL (que esta' mapeada no
                         * processo do jogo e vive tanto quanto a DLL). Sem
                         * malloc, sem free, sem CRT — a divergencia de alocador
                         * que eu temia simplesmente nao entra na equacao.
                         *
                         * Layout MSVC x64: quando _Myres > 15 o ponteiro em +0
                         * e' usado em vez do buffer interno. Basta apontar para
                         * g_textPtr e setar size/capacity. */
                        g_textPtr = g_textHeap;   /* buffer estatico desta DLL */
                        s.u.ptr = g_textPtr;
                        s.size = n;
                        s.cap = n;
                        memcpy(g_textHeap, g_gameCall.textBuf, n);
                    }
                    typedef void (*text_fn_t)(void *, uint32_t, uint32_t, void *);
                    text_fn_t tf = (text_fn_t)(uintptr_t)g_textFn;
                    tf((void *)(uintptr_t)g_textCtx, 1, 0, &s);
                    ok = 1;
text_done:
                    ;
                } else {
                    /* Game::walk(dir, 0): rcx ignorado, edx = direcao, r8b = 0
                     * (assinatura conferida no disasm do build vivo) */
                    typedef void (*walk_fn)(void *, uint32_t, uint8_t);
                    walk_fn fn = (walk_fn)(uintptr_t)g_walkFn;
                    fn(NULL, dir, 0);
                    ok = 1;
                }
            }
            InterlockedExchange(&g_gameCall.result, ok);
            /* so' agora COMPLETED — o chamador nunca ve resultado parcial */
            InterlockedExchange(&g_gameCall.state, GAME_CALL_COMPLETED);
        }
    }
    return CallNextHookEx(g_hook, code, wParam, lParam);
}

/* Descobre a thread dona da janela do jogo. */
static DWORD game_thread_id(HWND hwnd)
{
    if (g_gameThreadId) return g_gameThreadId;
    if (!hwnd) return 0;
    DWORD tid = GetWindowThreadProcessId(hwnd, NULL);
    if (tid) g_gameThreadId = tid;
    return tid;
}

/* Uma thread ainda esta viva? */
static int thread_alive(DWORD tid)
{
    if (!tid) return 0;
    HANDLE h = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, tid);
    if (!h) return 0;
    DWORD code = 0;
    int alive = 0;
    if (GetExitCodeThread(h, &code)) alive = (code == STILL_ACTIVE);
    CloseHandle(h);
    return alive;
}

/* Instala o hook na thread do jogo.
 *
 * WHY REINSTALAR: a cadeia de hooks WH_CALLWNDPROC e' mantida POR THREAD.
 * Quando a thread que chamou SetWindowsHookEx termina, a entrada some da
 * cadeia — mas g_hook continua nao-NULL, entao a checagem antiga
 * (`if (g_hook) return 1`) passava a mentir: o handle existia, a callback
 * nao estava mais instalada. A sessao do pipe cria uma thread por conexao;
 * a primeira conexao movia o personagem e as seguintes nao.
 *
 * MEDIDO em 2026-11-10: 1 movimento por sessao, depois
 * `envios=7 ok=7 falha=0` (janela consumia a mensagem) sem nenhuma entrada
 * na callback.
 *
 * Correcao (2026-11-10): se a thread que instalou morreu, desinstala e
 * instala de novo.
 *
 * Correcao REAL (2026-11-12): reinstalar na thread chamadora nao basta — a
 * thread chamadora tambem e' efemera (uma por conexao do pipe). Medido no
 * mesmo processo: 80 TIDs distintos instalaram o hook e houve 72
 * "hook orfao ... reinstalando". O hook sobrevivia ~1 conexao.
 *
 * Agora uma thread dedicada e persistente instala o hook UMA vez e fica num
 * message loop (GetMessage/DispatchMessage) ate' a DLL descarregar. Enquanto
 * ela viver, a entrada da cadeia nunca some. `ensure_game_hook` so' espera
 * essa thread ficar pronta.
 *
 * WHY message loop nao e' opcional: a thread dona de um hook instalado com
 * dwThreadId de OUTRA thread nao precisa bombear mensagens PARA o hook — o
 * Windows despacha o hook na thread alvo. Mas bombear mantem a thread viva de
 * forma barata e permite encerra-la com PostThreadMessage(WM_QUIT). Sem loop
 * a thread teria que dormir, e nao ha como acorda-la no shutdown. */

#define HOOK_THREAD_MSG (WM_APP + 0x51)

static DWORD WINAPI hook_thread_proc(LPVOID param)
{
    (void)param;
    g_hookThreadTid = GetCurrentThreadId();

    /* A janela alvo pode ainda nao existir quando a DLL e' injetada. Esperar
     * aqui (e nao no chamador) mantem o contrato de ensure_game_hook: quando
     * ela retorna 1, o hook esta' na cadeia. */
    HWND hwnd = g_targetHwnd;
    DWORD tid = hwnd ? game_thread_id(hwnd) : 0;
    if (!tid) {
        g_hookInstallFailed = 1;
        if (g_hookReadyEvent) SetEvent(g_hookReadyEvent);
        log_line("walk nativo: hook thread sem janela alvo");
        return 0;
    }

    if (!g_wakeMsg) {
        g_wakeMsg = RegisterWindowMessageA("PKA_WAKE_GAME_THREAD");
    }
    if (!g_wakeMsg) {
        g_hookInstallFailed = 1;
        if (g_hookReadyEvent) SetEvent(g_hookReadyEvent);
        log_line("walk nativo: RegisterWindowMessage falhou: %lu", GetLastError());
        return 0;
    }

    g_hook = SetWindowsHookExW(WH_CALLWNDPROC, game_call_hook, NULL, tid);
    if (!g_hook) {
        g_hookInstallFailed = 1;
        if (g_hookReadyEvent) SetEvent(g_hookReadyEvent);
        log_line("walk nativo: SetWindowsHookEx falhou: %lu", GetLastError());
        return 0;
    }

    g_hookOwnerTid = GetCurrentThreadId();
    g_hookInstallFailed = 0;
    log_line("walk nativo: hook instalado na thread %lu (janela %p), dono=%lu (persistente)",
             (unsigned long)tid, (void *)hwnd, (unsigned long)g_hookOwnerTid);
    if (g_hookReadyEvent) SetEvent(g_hookReadyEvent);

    /* Message loop: mantem a thread (e a entrada da cadeia) viva. */
    MSG msg;
    while (!g_stop && GetMessageW(&msg, NULL, 0, 0) > 0) {
        if (msg.message == HOOK_THREAD_MSG) continue;
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_hook) {
        UnhookWindowsHookEx(g_hook);
        g_hook = NULL;
    }
    log_line("walk nativo: hook thread encerrando (tid=%lu)", (unsigned long)g_hookThreadTid);
    return 0;
}

/* Garante que a thread persistente do hook existe e ja' instalou.
 * Devolve 1 se o hook esta' na cadeia. */
static int start_hook_thread(HWND hwnd)
{
    if (!hwnd) return 0;
    g_targetHwnd = hwnd;

    if (g_hookThread && thread_alive(g_hookThreadTid) && g_hook) return 1;

    /* Serializa a inicializacao: duas conexoes simultaneas nao podem criar
     * duas threads donas do hook (a segunda derrubaria a primeira da cadeia). */
    static volatile LONG starting = 0;
    if (InterlockedCompareExchange(&starting, 1, 0) != 0) {
        /* outra thread esta' criando; esperar ela terminar */
        for (int i = 0; i < 100; i++) {
            Sleep(20);
            if (g_hook && thread_alive(g_hookOwnerTid)) return 1;
            if (g_hookInstallFailed) return 0;
        }
        return (g_hook && thread_alive(g_hookOwnerTid)) ? 1 : 0;
    }

    /* Se a thread morreu (nao deveria, mas nunca assumir), recomecar limpo. */
    if (g_hookThread && !thread_alive(g_hookThreadTid)) {
        log_line("walk nativo: hook thread %lu morreu; recriando",
                 (unsigned long)g_hookThreadTid);
        CloseHandle(g_hookThread);
        g_hookThread = NULL;
        if (g_hook) { UnhookWindowsHookEx(g_hook); g_hook = NULL; }
    }

    if (!g_hookReadyEvent) {
        g_hookReadyEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
        if (!g_hookReadyEvent) { InterlockedExchange(&starting, 0); return 0; }
    }
    ResetEvent(g_hookReadyEvent);
    g_hookInstallFailed = 0;

    g_hookThread = CreateThread(NULL, 0, hook_thread_proc, NULL, 0, NULL);
    if (!g_hookThread) {
        log_line("walk nativo: CreateThread(hook) falhou: %lu", GetLastError());
        InterlockedExchange(&starting, 0);
        return 0;
    }
    /* Registra no array global para o PkaShutdown esperar. */
    if (g_threadCount < (int)(sizeof g_threads / sizeof g_threads[0]))
        g_threads[g_threadCount++] = g_hookThread;

    DWORD wr = WaitForSingleObject(g_hookReadyEvent, 2000);
    int ok = (wr == WAIT_OBJECT_0) && !g_hookInstallFailed && g_hook != NULL;
    if (!ok) {
        log_line("walk nativo: hook thread nao ficou pronta (wait=%lu fail=%ld hook=%p)",
                 (unsigned long)wr, (long)g_hookInstallFailed, (void *)g_hook);
    }
    InterlockedExchange(&starting, 0);
    return ok ? 1 : 0;
}

static int ensure_game_hook(HWND hwnd)
{
    DWORD tid = game_thread_id(hwnd);
    if (!tid) {
        log_line("walk nativo: thread da janela desconhecida");
        return 0;
    }

    /* Se a thread persistente ja' esta' viva com o hook na cadeia, pronto.
     * A checagem antiga comparava g_hookOwnerTid com uma thread efemera; agora
     * o dono e' a thread persistente, entao estar viva e' condicao necessaria
     * E suficiente. */
    if (g_hook && thread_alive(g_hookOwnerTid)) return 1;

    return start_hook_thread(hwnd);
}

/* Resultado de executar na thread do jogo. TRI-ESTADO — nunca binario.
 *
 * A distincao CLAIMED vs RUNNING e' o que impede o bug de duplicar movimento:
 * se o hook JA' pegou o pedido e a funcao esta em curso, um timeout NAO
 * significa "nao aconteceu" — significa "nao sei ainda". Nesse caso o
 * chamador NAO pode tentar o fallback: a acao vai acontecer, e tentar de novo
 * move duas vezes.
 */
#define GAME_EXEC_DONE      1   /* funcao executou e retornou */
#define GAME_EXEC_FAILED    0   /* nao chegou a executar (hook nao pegou) */
#define GAME_EXEC_INDETERMINATE (-1)  /* comecou a executar; resultado desconhecido */

static int run_in_game_thread(HWND hwnd, uint64_t fn, uint32_t direction,
                              DWORD timeoutMs)
{
    if (!ensure_game_hook(hwnd)) return GAME_EXEC_FAILED;
    if (!fn) return GAME_EXEC_FAILED;

    /* serializa: se ja' ha' pedido em voo, recusa em vez de atropelar o slot */
    if (g_gameCall.state != GAME_CALL_IDLE && g_gameCall.state != GAME_CALL_COMPLETED) {
        log_line("walk nativo: pedido anterior ainda em voo (state=%ld); recusado",
                 (long)g_gameCall.state);
        return GAME_EXEC_FAILED;
    }

    /* NAO zera textLen aqui: quem chama decide o caminho. O walk zera antes
     * de chamar; o texto preenche antes. Ver run_text_in_game_thread. */

    g_walkFn = fn;
    g_gameCall.direction = direction;
    InterlockedExchange(&g_gameCall.result, 0);
    InterlockedExchange(&g_gameCall.ownerSeq, 0);
    LONG mySeq = InterlockedIncrement(&g_gameCall.seq);
    /* publica CLAIMED por ULTIMO: o hook so' age depois deste ponto */
    InterlockedExchange(&g_gameCall.state, GAME_CALL_CLAIMED);

    DWORD waited = 0;
    int claimed = 0;
    int sends = 0, sendOk = 0, sendFail = 0;
    DWORD lastSendErr = 0;
    while (waited < timeoutMs) {
        /* Acorda o message loop da thread alvo com SendMessageTimeoutW.
         *
         * WHY NOT PostMessage: WH_CALLWNDPROC dispara para mensagens
         * ENVIADAS (SendMessage), nao postadas. Medido em 2026-11-10: com
         * PostMessage(WM_NULL) o hook nunca rodava e o walk sempre caia no
         * fallback ("hook nao pegou o pedido em 300 ms").
         *
         * WHY NOT WM_NULL: medido em 2026-11-10 — 1 de 4 envios disparava o
         * hook. WM_NULL e' filtrada antes do despacho; o SendMessageTimeout
         * retorna sucesso mas a callback nao roda. Agora usa uma mensagem
         * privada registrada (0xC000..0xFFFF), que atravessa o despacho.
         *
         * SendMessageTimeout bloqueia ate' o hook CALLWNDPROC rodar (ele roda
         * ANTES do WndProc). SMTO_ABORTIFHUNG evita travar em loading.
         *
         * LIMITE HONESTO: o retorno confirma que a MENSAGEM foi processada,
         * nao que Game::walk retornou. A evidencia de execucao e' a transicao
         * CLAIMED->RUNNING->COMPLETED com ownerSeq == meuSeq. O retorno e'
         * registrado justamente para separar "nao despachou" de "despachou
         * mas a janela nao consumiu". */
        DWORD_PTR msgResult = 0;
        DWORD sendErr = 0;
        SetLastError(0);
        LRESULT sent = SendMessageTimeoutW(hwnd, g_wakeMsg, (WPARAM)mySeq, 0,
                                           SMTO_ABORTIFHUNG | SMTO_BLOCK, 150, &msgResult);
        sends++;
        if (sent == 0) {
            /* 0 = falhou OU estourou o timeout; GetLastError diz qual */
            sendFail++;
            sendErr = GetLastError();
            lastSendErr = sendErr ? sendErr : ERROR_TIMEOUT;
        } else {
            sendOk++;
        }
        waited += 150;

        LONG st = g_gameCall.state;
        if (st == GAME_CALL_RUNNING) claimed = 1;
        if (st == GAME_CALL_COMPLETED) {
            /* confere que o resultado e' DESTE pedido, nao do anterior */
            if (g_gameCall.ownerSeq != mySeq) {
                log_line("walk nativo: resultado de outro pedido (owner=%ld meu=%ld)",
                         (long)g_gameCall.ownerSeq, (long)mySeq);
                return GAME_EXEC_INDETERMINATE;
            }
            int ok = g_gameCall.result != 0;
            InterlockedExchange(&g_gameCall.state, GAME_CALL_IDLE);
            return ok ? GAME_EXEC_DONE : GAME_EXEC_FAILED;
        }
    }

    if (claimed) {
        /* JA' ESTAVA EXECUTANDO quando o tempo acabou. NAO devolver falha: o
         * movimento pode acontecer. Deixar o estado como esta' e' proposital —
         * o hook vai terminar e marcar COMPLETED; o proximo pedido sera'
         * recusado ate' la'. */
        log_line("walk nativo: INDETERMINADO — hook ja' executava e nao terminou "
                 "em %lu ms. NAO faco fallback: a acao pode ocorrer.", (unsigned long)timeoutMs);
        return GAME_EXEC_INDETERMINATE;
    }

    /* nunca foi pego pelo hook: seguro dizer que nao aconteceu */
    InterlockedExchange(&g_gameCall.state, GAME_CALL_IDLE);
    log_line("walk nativo: hook nao pegou o pedido em %lu ms "
             "(envios=%d ok=%d falha=%d ultimoErro=%lu msg=0x%04x entradas=%ld)",
             (unsigned long)timeoutMs, sends, sendOk, sendFail,
             (unsigned long)lastSendErr, (unsigned)g_wakeMsg, (long)g_hookEntries);
    return GAME_EXEC_FAILED;
}

/* Resolve e valida o caminho nativo de TEXTO (talk/combo).
 *
 * Mesmos gates que o fornecedor checa antes de chamar 0x785050 (ver
 * TEXT_FN_RVA). Falhar aqui NAO e' erro de leitura: e' o jogo dizendo que
 * nao esta' pronto. Devolve 0 com motivo no log.
 *
 * A verificacao do prologo e' obrigatoria: o RVA muda por build e chamar um
 * endereco que nao e' mais o consumidor corromperia o cliente. */
static int resolve_text_path(HWND *outHwnd)
{
    uint64_t base = module_base_for_chain();
    if (!base) {
        log_line("texto nativo: base do modulo nao resolvida");
        return 0;
    }
    uint64_t fn = base + TEXT_FN_RVA;

    /* prologo exato medido ao vivo (32 bytes) */
    static const uint8_t expect[20] = {
        0x48,0x89,0x5c,0x24,0x08,0x48,0x89,0x6c,0x24,0x18,
        0x56,0x57,0x41,0x56,0x48,0x83,0xec,0x70,0x49,0x8b
    };
    uint8_t head[20];
    if (!mem_read(fn, head, sizeof head)) {
        log_line("texto nativo: leitura do prologo falhou em %#llx",
                 (unsigned long long)fn);
        return 0;
    }
    if (memcmp(head, expect, sizeof head) != 0) {
        log_line("texto nativo: prologo NAO confere em exe+%#llx — build diferente, "
                 "recusado", (unsigned long long)TEXT_FN_RVA);
        return 0;
    }

    /* gates de sessao, exatamente os que o consumidor checa no seu corpo */
    uint8_t gate = 0, reentry = 0;
    mem_read(base + TEXT_GATE_RVA, &gate, 1);
    mem_read(base + TEXT_REENTRY_RVA, &reentry, 1);
    if (!gate) {
        log_line("texto nativo: gate de sessao fechado ([%#llx]=0)",
                 (unsigned long long)TEXT_GATE_RVA);
        return 0;
    }
    if (reentry) {
        log_line("texto nativo: reentrada ativa ([%#llx]=%u); recusado",
                 (unsigned long long)TEXT_REENTRY_RVA, reentry);
        return 0;
    }

    /* LocalPlayer vivo e com HP > 0 (o consumidor exige [LP+0xb0] > 0) */
    uint64_t lp = 0;
    if (!mem_read(base + 0x39F8E08ULL, &lp, sizeof lp) || !lp) {
        /* o global pode estar NULL em transicao de mapa; nao e' falha fatal,
         * mas o consumidor recusaria — entao recusamos com o motivo certo */
        log_line("texto nativo: LocalPlayer global NULL (transicao de mapa?)");
        return 0;
    }
    uint8_t hp = 0;
    if (!mem_read(lp + 0xb0, &hp, 1) || !hp) {
        log_line("texto nativo: [LP+0xb0]=0 (sem HP/alvo); consumidor recusaria");
        return 0;
    }

    /* objeto de contexto para rcx */
    uint64_t ctx = 0;
    if (!mem_read(base + TEXT_CTX_RVA, &ctx, sizeof ctx) || !ctx) {
        log_line("texto nativo: objeto de contexto [%#llx] NULL",
                 (unsigned long long)TEXT_CTX_RVA);
        return 0;
    }

    HWND hwnd = locate_window();
    if (!hwnd) {
        log_line("texto nativo: janela do jogo nao encontrada");
        return 0;
    }

    g_textFn = fn;
    g_textCtx = ctx;
    if (outHwnd) *outHwnd = hwnd;
    return 1;
}

/* Envia texto (talk/combo) pelo caminho NATIVO — sem tecla, sem foco.
 *
 * O texto vai para g_gameCall.textBuf (no processo do jogo) e o hook monta a
 * std::string na pilha da thread do jogo. Nao ha PostMessage de WM_CHAR, nao
 * ha Enter, nao ha gate de foreground. */
static int run_text_in_game_thread(const char *text, uint32_t textLen,
                                   HWND hwnd, DWORD timeoutMs)
{
    if (!text || textLen == 0 || textLen > (uint32_t)sizeof g_gameCall.textBuf) {
        log_line("texto nativo: tamanho invalido (%u)", (unsigned)textLen);
        return GAME_EXEC_FAILED;
    }
    if (!g_textFn) {
        log_line("texto nativo: caminho nao resolvido; recusado");
        return GAME_EXEC_FAILED;
    }

    /* reset do motivo: cada pedido comeca limpo, senao um 5 anterior vaza
     * para o log de um 4 bem-sucedido */
    InterlockedExchange(&g_textSkipReason, TEXT_SKIP_NONE);

    /* publica o texto ANTES de entrar no laco; run_in_game_thread publica
     * CLAIMED como ultima escrita antes de acordar a thread do jogo, entao a
     * thread do jogo ve o buffer completo */
    memcpy(g_gameCall.textBuf, text, textLen);
    InterlockedExchange(&g_gameCall.textLen, (LONG)textLen);

    int r = run_in_game_thread(hwnd, g_textFn, 0, timeoutMs);
    InterlockedExchange(&g_gameCall.textLen, 0);
    return r;
}

/* Resolve o interpretador de "!autocombo" (exe+0x67fbf0).
 *
 * Prologo medido ao vivo (2026-11-14):
 *   40 55 53 56 57 41 54 41 55 41 56 41 57 48 8d 6c 24 e1 48 81 ec f8 00 00 00
 *
 * O RVA muda por build, entao a validacao do prologo e' obrigatoria — chamar
 * um endereco que nao e' mais o interpretador executaria codigo arbitrario.
 * Aqui NAO ha varredura por pattern: o endereco veio do scan de chamadores de
 * 0x785050 e da string "!autocombo", e o prologo confirma. Se um build novo
 * mudar, isto recusa com log em vez de arriscar. */
static int resolve_combo_interp(void)
{
    if (g_comboInterp) return 1;
    uint64_t base = module_base_for_chain();
    if (!base) {
        log_line("combo: base do modulo nao resolvida");
        return 0;
    }
    uint64_t fn = base + COMBO_INTERP_RVA;
    static const uint8_t expect[24] = {
        0x40,0x55,0x53,0x56,0x57,0x41,0x54,0x41,0x55,0x41,0x56,0x41,
        0x57,0x48,0x8d,0x6c,0x24,0xe1,0x48,0x81,0xec,0xf8,0x00,0x00
    };
    uint8_t head[24];
    if (!mem_read(fn, head, sizeof head)) {
        log_line("combo: leitura do prologo falhou em %#llx",
                 (unsigned long long)fn);
        return 0;
    }
    if (memcmp(head, expect, sizeof head) != 0) {
        log_line("combo: prologo NAO confere em exe+%#llx (build diferente); "
                 "interpretador de !autocombo recusado",
                 (unsigned long long)COMBO_INTERP_RVA);
        return 0;
    }
    g_comboInterp = fn;
    log_line("combo: interpretador de !autocombo resolvido em exe+%#llx",
             (unsigned long long)COMBO_INTERP_RVA);
    return 1;
}

/* Envia "!autocombo" (literal, 10 bytes) pelo INTERPRETADOR.
 *
 * WHY separado do texto: o interpretador exige size==10 e o literal exato
 * (cmp r8,10 + strncmp no prologo). Mandar "!autocombo m5" e' descartado em
 * silencio — foi o que fez o bot "usar so' a primeira habilidade", porque o
 * texto caia no consumidor de CHAT e nada disparava.
 *
 * A sequencia de skills NAO vai no texto: o runtime do jogo ja' a tem da
 * config (combo.sequenceText). O comando so' liga/desliga o modo. */
static int run_combo_in_game_thread(HWND hwnd, DWORD timeoutMs)
{
    if (!resolve_combo_interp()) return GAME_EXEC_FAILED;
    /* comboMode=1 avisa o hook para chamar o interpretador em vez do chat */
    InterlockedExchange(&g_gameCall.comboMode, 1);
    InterlockedExchange(&g_gameCall.textLen, 10);
    memcpy(g_gameCall.textBuf, "!autocombo", 10);
    int r = run_in_game_thread(hwnd, g_comboInterp, 0, timeoutMs);
    InterlockedExchange(&g_gameCall.comboMode, 0);
    InterlockedExchange(&g_gameCall.textLen, 0);
    return r;
}

static uint32_t execute_command(uint32_t id, uint32_t type, const uint8_t *payload, size_t len,
                                uint16_t *outKey, int *haveKey)
{
    *haveKey = 0;
    /* Registra o foreground NO INSTANTE do comando.
     *
     * WHY: "funcionou em segundo plano" e' uma afirmacao sobre o estado da
     * janela no momento exato da acao. Verificar o foreground antes e depois
     * pelo shell nao prova nada — a janela pode ter mudado no meio, e o ACK
     * nao carrega essa informacao. Este log e' a evidencia: para cada comando,
     * `fg=<pid>` diz qual processo tinha o foco quando a acao rodou. */
    {
        HWND fg = GetForegroundWindow();
        DWORD fgPid = 0;
        if (fg) GetWindowThreadProcessId(fg, &fgPid);
        log_line("cmd id=%u tipo=%u: fg=%lu (jogo=%lu) %s", id, type,
                 (unsigned long)fgPid, (unsigned long)g_targetPid,
                 fgPid == (DWORD)g_targetPid ? "EM FOCO" : "SEGUNDO PLANO");
    }
    /* tipo 1 walk: 0..7 -> setas.
     *
     * Scan codes fixos, extensao ligada: e' o contrato de tools/walker_input.py,
     * o unico emissor que comprovadamente movimentou o cliente. Direcoes
     * diagonais caem no eixo vertical ate' o smart-walk do motor lidar com elas. */
    static const struct { uint16_t vk; uint8_t scan; } arrows[8] = {
        { VK_UP, 0x48 }, { VK_RIGHT, 0x4D }, { VK_DOWN, 0x50 }, { VK_LEFT, 0x4B },
        { VK_UP, 0x48 }, { VK_DOWN, 0x50 }, { VK_DOWN, 0x50 }, { VK_UP, 0x48 },
    };
    if (type == 1) {
        if (len < 12) return STATUS_BAD_COMMAND;
        uint32_t dir = 0;
        memcpy(&dir, payload + 8, 4);
        if (dir > 7) return STATUS_BAD_COMMAND;
        HWND hwnd = locate_window();
        if (!hwnd) return STATUS_NO_WINDOW;

        /* CAMINHO NATIVO PRIMEIRO: Game::walk na thread do jogo.
         *
         * `Game::walk` = exe+0x780c90 neste build. Assinatura conferida no
         * disasm vivo: rcx IGNORADO (nao salvo nem usado no prologo),
         * edx = direcao, r8b = 0.
         *
         * Dois chamadores reais no exe: 0x74742a (A/B/C) e 0x7b6381 (wrapper
         * do autowalk). Ambos passam a direcao em edx.
         *
         * Roda na thread da message loop via hook — ver run_in_game_thread.
         * Nao exige foco: nao ha tecla, e' chamada de funcao.
         */
        uint64_t base0 = module_base_for_chain();
        if (base0) {
            uint64_t walkFn = base0 + WALK_FN_RVA;
            /* valida o prologo antes de chamar: se o build mudou, recusa */
            uint8_t head[8];
            static const uint8_t expect[8] = { 0x48,0x89,0x5c,0x24,0x08,0x55,0x56,0x57 };
            if (mem_read(walkFn, head, sizeof head) &&
                memcmp(head, expect, sizeof expect) == 0) {
                /* caminho de walk: zera o contexto de texto para o hook nao
                 * confundir este pedido com um talk/combo */
                InterlockedExchange(&g_gameCall.textLen, 0);
                int r = run_in_game_thread(hwnd, walkFn, dir, 1000);
                if (r == GAME_EXEC_DONE) {
                    log_line("walk nativo: dir=%u na thread do jogo", dir);
                    return STATUS_OK;
                }
                if (r == GAME_EXEC_INDETERMINATE) {
                    /* A funcao COMECOU a executar. Nao sabemos se terminou.
                     * Fazer fallback aqui poderia mover DUAS vezes. Devolver
                     * "nao sei" e' a unica resposta honesta — e o chamador
                     * (walker) trata como pendente, nao como falha. */
                    log_line("walk nativo: resultado INDETERMINADO (dir=%u); "
                             "sem fallback para nao duplicar movimento", dir);
                    return STATUS_UNSUPPORTED;
                }
                log_line("walk nativo: nao executou; tentando teclado (exige foco)");
            } else {
                log_line("walk nativo: prologo de Game::walk nao confere neste build; "
                         "caindo no teclado");
            }
        }

        /* FALLBACK: teclado. Exige primeiro plano (medido em 2026-11-05:
         * sem foco = 0 movimento). Mantido para nao perder o unico caminho
         * que ja' foi validado no cliente. */
        if (background_requested()) {
            log_line("walk recusado: modo background nao suportado (fallback teclado)");
            return STATUS_BACKGROUND_UNSUPPORTED;
        }
        /* PostMessageA nao depende de foco. Medido 2026-11-20 com o jogo
         * minimizado: 3/3 passos entregues. O gate virou log. */
        if (!require_foreground(hwnd)) {
            log_line("walk: teclado EM SEGUNDO PLANO (postando mesmo assim)");
        }
        if (!tap_key_ex(hwnd, arrows[dir].vk, arrows[dir].scan, 1)) return STATUS_SEND_FAILED;
        return STATUS_OK;
    }
    /* tipo 20 hotkey: len do texto em 8, texto logo apos os 24 bytes fixos.
     * protocol.cjs faz Buffer.concat([bytes(24), text]) -> texto comeca em 24,
     * nao em 12 (12..23 sao uuidHash/expectedAction). */
    if (type == 20) {
        if (len < 24) return STATUS_BAD_COMMAND;
        uint32_t textLen = 0;
        memcpy(&textLen, payload + 8, 4);
        if (textLen == 0 || 24 + textLen > len) return STATUS_BAD_COMMAND;
        const char *text = (const char *)payload + 24;
        uint16_t vk = 0;
        int mods = 0;
        /* parse_key_spec aceita tecla unica, F1..F12 e combinacoes
         * "ctrl+shift+alt+tecla" — o formato da config do Shiba. */
        if (!parse_key_spec(text, textLen, &vk, &mods)) return STATUS_BAD_COMMAND;
        HWND hwnd = locate_window();
        if (!hwnd) return STATUS_NO_WINDOW;
        /* HOTKEY EM SEGUNDO PLANO — MEDIDO (2026-11-13).
         *
         * O gate antigo era `require_foreground(hwnd)`, que exige
         * `GetForegroundWindow()==hwnd`. Isso fazia `potion` e `revive`
         * devolverem SEMPRE status 5 com o jogo minimizado — inutil para um
         * bot que roda em background.
         *
         * Mas `tap_key_with_mods` usa `PostMessageA`, que NAO exige foco: a
         * mensagem e' postada na fila da janela alvo. O proprio walk ja'
         * depende disso (`Game::walk` e' chamada direta, nao tecla).
         *
         * Entao: posta primeiro, sem gate de foco. Se o jogo estiver
         * minimizado/coberto e a tecla nao surtir efeito, o consumidor mede
         * (HP nao cai, pokemon nao volta) e pode pedir foco. Recusar de saida
         * sem tentar era o erro.
         *
         * Mantemos o modo `PKA_EXECUTOR_MODE=background` como recusa EXPLICITA
         * para quem quer garantir que a DLL nunca poste tecla (auditoria). */
        if (background_requested()) {
            log_line("hotkey recusada: PKA_EXECUTOR_MODE=background (recusa explicita)");
            return STATUS_BACKGROUND_UNSUPPORTED;
        }
        if (!tap_key_with_mods(hwnd, vk, mods)) {
            log_line("hotkey: PostMessage falhou (janela %p vk=%u)", (void *)hwnd, vk);
            return STATUS_SEND_FAILED;
        }
        log_line("hotkey: vk=%u mods=%d postada%s", vk, mods,
                 GetForegroundWindow() == hwnd ? " (foreground)" : " (SEGUNDO PLANO)");
        *outKey = vk;
        *haveKey = 1;
        return STATUS_OK;
    }
    /* tipo 4 stop: parar o personagem.
     *
     * `applied` aqui significa APENAS: a DLL recebeu o comando e nao tem mais
     * tecla pendente para emitir. NAO significa que o cliente cancelou
     * movimento — nao existe chamada ao jogo que faca isso nesta DLL, e nao
     * inventamos uma. A parada efetiva que controlamos e' parar de despachar,
     * o que acontece na camada Node (runtime.stop). */
    if (type == 4) {
        return STATUS_OK;
    }
    /* tipo 2 attack: alvo em payload+8 (u32).
     *
     * Caminho: chamar o handler nativo de attack com o ponteiro da entidade.
     * O handler tem stack cookie (`__security_cookie`) e alinhamento de pilha
     * proprio, entao chamar de fora exige respeitar a ABI inteira. Esta
     * implementacao NAO chama por padrao: resolve o handler, valida o alvo e
     * reporta. Chamar de verdade fica atras de PKA_ATTACK_FIRE=1.
     *
     * Status honesto:
     *   STATUS_UNSUPPORTED (4)  = handler nao resolvido / modo desligado
     *   STATUS_SEND_FAILED (2)  = tentou e falhou
     *   STATUS_OK (0)           = chamou e o handler devolveu != 0
     */
    if (type == 2) {
        uint32_t targetId = 0;
        if (len >= 12) memcpy(&targetId, payload + 8, 4);
        if (targetId == 0) {
            log_line("attack recusado: targetId=0");
            return STATUS_BAD_COMMAND;
        }
        uint64_t base = module_base_for_chain();
        uint64_t handler = resolve_attack_handler();
        if (!handler || !base) {
            log_line("attack: handler nao resolvido neste build");
            return STATUS_UNSUPPORTED;
        }

        /* O runtime do jogo e' um OBJETO ESTATICO em .data, nao um ponteiro:
         * rcx = base + RUNTIME_RVA. Medido em 2026-11-09 (PID 7368):
         *
         *   [runtime+0x2528] = LocalPlayer  (validado: name="Usobot")
         *   [runtime+0x2668] = gate de prontidao  (1 = pronto)
         *   [runtime+0x266a] = flag de reentrada  (deve ser 0)
         *
         * O handler NAO recebe o id: ele recebe o PONTEIRO da entidade em rdx
         * (o lookup id->entidade acontece antes, no dispatcher). Como eu ja
         * tenho o VA de cada criatura da varredura, entrego direto.
         */
        uint64_t runtime = base + RUNTIME_RVA;
        uint8_t gate = 0, reentry = 0;
        mem_read(runtime + 0x2668, &gate, 1);
        mem_read(runtime + 0x266a, &reentry, 1);
        if (!gate) {
            log_line("attack recusado: runtime nao pronto (gate[+0x2668]=%u)", gate);
            return STATUS_SEND_FAILED;
        }
        if (reentry) {
            log_line("attack recusado: runtime em reentrada (flag[+0x266a]=%u)", reentry);
            return STATUS_SEND_FAILED;
        }

        /* acha a entidade pelo id na lista observada */
        uint64_t targetVa = 0;
        creature_t *tgt = NULL;
        for (int i = 0; i < g_creatureCount; i++) {
            if (g_creatures[i].id == targetId) { tgt = &g_creatures[i]; break; }
        }
        if (!tgt) {
            log_line("attack recusado: alvo %u nao esta na lista observada", targetId);
            return STATUS_SEND_FAILED;
        }
        targetVa = g_creatureVa[(int)(tgt - g_creatures)];
        if (!targetVa) {
            log_line("attack recusado: VA do alvo %u nao registrado", targetId);
            return STATUS_SEND_FAILED;
        }

        /* O ATAQUE E' EXECUTADO PELO POKEMON ATIVO, NAO PELO JOGADOR.
         *
         * MEDIDO (2026-11-12, ciclo de 7 ataques): os 7 chamaram o handler e
         * devolveram codigo NAO-ZERO (13, 11, 7, 5, 5, 7, 11) — mas NENHUM
         * baixou HP de alvo adjacente (dist 1-2, dz 0). No mesmo instante:
         *
         *     [runtime+0x2568] self/pokemon = 0x0
         *     scan_creatures -> "aliado=nenhum"
         *
         * O disasm do handler (docs/CANAL_NATIVO_TESTE.md, +0x16e):
         *     mov rsi,[rbx+0x2568]   ; self = POKEMON ATIVO
         *     mov rcx,[rdi]          ; sp.obj = alvo
         *     call +0x8d7df          ; ACAO: (self, alvoId, contador)
         *
         * A acao recebe `self` como PRIMEIRO argumento. Sem Pokemon ativo
         * (`0x0`), a acao nao tem quem execute a move: roda, conta a
         * tentativa e devolve um codigo de "nada feito" — que o nosso
         * `if (rc)` antigo interpretava como sucesso.
         *
         * Por isso a guarda aqui: sem `self` nao ha ataque. Recusar ANTES
         * de chamar evita (a) mentir status 0, (b) gastar refcount do
         * control block e (c) sujar a medicao de efeito com falsos
         * "executou sem dano". */
        uint64_t selfPokemon = rd_u64(runtime + 0x2568);
        if (!selfPokemon) {
            log_line("attack recusado: sem Pokemon ativo (self[+0x2568]=0). "
                     "A acao e' executada pelo pokemon, nao pelo jogador.");
            return STATUS_SEND_FAILED;
        }

        /* Flag de disparo: arquivo ao lado da DLL, nao variavel de ambiente.
         * Processo ja em execucao NAO herda ambiente novo — foi por isso que
         * `set PKA_ATTACK_FIRE=1` no shell nao teve efeito nenhum no jogo.
         * Mesmo padrao de pka_player_name.txt / pka_channel_key.txt. */
        int wantFire = attack_fire_enabled();
        log_line("attack %s: handler=exe+%#llx runtime=%#llx alvo=%u (%s hp=%d) entidade=%#llx",
                 wantFire ? "FIRE" : "dry-run",
                 (unsigned long long)(handler - base), (unsigned long long)runtime,
                 targetId, tgt->name, tgt->hp, (unsigned long long)targetVa);
        if (!wantFire) return STATUS_UNSUPPORTED;

        /* Chamada real.
         *
         * ABI medida no disasm (exe+0x784be0):
         *     uint8_t handler(void *runtime [rcx], void *entidade [rdx],
         *                     uint8_t mode [r8])
         *
         * MAS o disasm mostra algo critico: o handler NAO usa rdx para
         * escolher o alvo. Ele le o alvo de [runtime+0x2528]:
         *
         *   +0x2d  cmp byte [rcx+0x2668],0    gate
         *   +0x3a  mov rdx,[rcx+0x2528]      <- ALVO ATUAL DO RUNTIME
         *   +0x4a  cmp byte [rdx+0xb0],0     HP do alvo
         *   +0x64  mov rcx,[rcx+0x2568]      self (proprio pokemon)
         *
         * E o 2o argumento NAO e' um ponteiro de entidade: e' o endereco de
         * um shared_ptr<Entity> na pilha do chamador. Os 3 chamadores reais
         * fazem, antes do call:
         *
         *   lock inc dword [rbx+8]      ; refcount do control block
         *   movdqa [rsp+0x30],xmm0      ; {obj, ctrl} na pilha
         *   lea rdx,[rsp+0x30]          ; rdx = &shared_ptr
         *   call handler
         *
         * e o handler le [rdi] como obj e [rdi+8] como ctrl. Passar a
         * entidade crua ali faz ele tratar o ENDERECO como obj — foi o erro
         * da primeira tentativa (sem efeito, sem crash por sorte).
         *
         * Caminho correto:
         *   1. monta shared_ptr{obj=criatura, ctrl=control_block} na pilha
         *   2. chama handler(runtime, &shared_ptr, 0)
         *   3. NAO mexe em [runtime+0x2528]
         *
         * Por que nao escrever no slot: o handler faz
         *     mov rax,[rdi]        ; sp.obj
         *     cmp rax,rdx          ; rdx = [runtime+0x2528]
         *     je  saida            ; se IGUAIS, nao ataca
         * Ou seja: o slot e' o "alvo atual" e a comparacao evita atacar o
         * proprio alvo. Escrever a criatura nos DOIS faz o handler sair
         * imediatamente — foi o que aconteceu na tentativa anterior (sem
         * efeito). O correto e' passar a criatura APENAS no argumento.
         *
         * O control block: shared_ptr precisa de um. Uso o do shared_ptr<Tile>
         * que o LocalPlayer ja carrega (+0x9b0).
         *
         * ─── O QUE REALMENTE BLOQUEIA O DANO (medido 2026-11-13) ───
         *
         * Decodifiquei o handler byte a byte e medi os tres slots ao vivo:
         *
         *     [rt+0x2528] = LocalPlayer   (SEM = "Vousabotdenovo")
         *     [rt+0x2548] = ALVO ATUAL DO JOGO, volatil
         *                   (SEM medido = "Gloom" hp=42; depois 0x0 quando morreu)
         *     [rt+0x2568] = proprio Pokemon (self)
         *
         * E o handler faz DUAS recusas silenciosas:
         *
         *   +0x81  mov  rax, [rdi]              ; sp.obj = criatura que passamos
         *   +0x84  cmp  rax, rdx                ; rdx = [rt+0x2528] = LocalPlayer
         *   +0x87  je   +0x1a2                  ; se for o jogador -> sai
         *   +0x96  cmp  rax, [rbx+0x2548]       ; ALVO ATUAL
         *   +0x9d  jne  +0xe8                   ; se DIFERENTE -> ataca (bom)
         *          (fall-through = monta shared_ptr VAZIO e nao ataca)
         *
         * Consequencia pratica: mandar `attack` no alvo que o JOGO ja' tem
         * como atual devolve status 0 e NAO faz dano. Foi exatamente o que
         * medi: `attack -> status 0`, `handler devolveu 11`, HP do Magnemite
         * parado em 73% por 4,2 s. O retorno 11 e' lixo de EAX (o handler
         * devolve um struct em [rsp+0x20], como o COMBAT_NATIVE_PROVEN.md
         * documenta) — nao e' codigo de sucesso.
         *
         * O que NAO fazer: escrever no +0x2548. Ele e' estado do jogo; mexer
         * nele pode dessincronizar o runtime do cliente. A leitura serve para
         * DIAGNOSTICO: se a criatura pedida == [rt+0x2548], o handler vai
         * recusar e o consumidor precisa saber disso em vez de achar que
         * acertou.
         *
         * CORRECAO CRITICA (2026-11-09, crash apos 3 chamadas):
         * O handler DESTROI o shared_ptr no epilogo:
         *     +0x1a2  48 8b 4f 08       mov rcx,[rdi+8]   ; sp.ctrl
         *     +0x1ab  e8 ..             call <destrutor>  ; decrementa refcount
         * Ou seja: ele TOMA OWNERSHIP da copia. O padrao correto de passar um
         * shared_ptr por valor e':
         *
         *     copiar (++ refcount) -> passar -> a funcao destroi a copia (--)
         *
         * A versao anterior fazia ++ ANTES e -- DEPOIS:
         *     ++meu (2->3) -> handler -- (3->2) -> --meu (2->1)
         *   = NET -1 POR CHAMADA. Tres chamadas zeraram o refcount do Tile
         *   do LocalPlayer, o Tile foi liberado e o jogo morreu ~9 min depois
         *   sem log (22:49-22:50 attacks, morte 22:59).
         *
         * Agora: ++ antes, e NAO decrementa depois — o handler ja consumiu. */
        /* shared_ptr {obj, ctrl} na nossa pilha.
         *
         * O ctrl vem de g_creatureCb[] — o control block DE VERDADE da
         * criatura (`?$_Ref_count_obj2@VMonster@@@std`, casado pelo +0x18).
         * Antes vinha emprestado do shared_ptr<Tile> do LocalPlayer (+0x9b0),
         * que era errado e podia estar NULL. */
        uint64_t sp[2];
        sp[0] = targetVa;
        sp[1] = 0;
        int idx = (int)(tgt - g_creatures);
        if (idx >= 0 && idx < g_creatureCount) sp[1] = g_creatureCb[idx];
        if (!sp[1]) {
            /* Sem control block nao ha shared_ptr valido: o handler
             * desreferencia [rdi+8] e chama o destrutor. Aborta. */
            log_line("attack: sem control block para o shared_ptr, abortado "
                     "(criatura %u, idx %d)", targetId, idx);
            return STATUS_SEND_FAILED;
        }
        {
            uint32_t rc0 = 0;
            mem_read(sp[1] + 8, &rc0, 4);
            rc0++;
            if (!write_mem(sp[1] + 8, &rc0, 4)) {
                log_line("attack: falha ao incrementar refcount do ctrl %#llx",
                         (unsigned long long)sp[1]);
                return STATUS_SEND_FAILED;
            }
        }
        /* Diagnostico ANTES de chamar: o handler recusa em silencio quando a
         * criatura pedida ja' e' o alvo atual do jogo ([rt+0x2548]). Registrar
         * isso separa "recusamos" de "o jogo recusou" — o consumidor hoje ve'
         * status 0 e assume acerto. Ver o bloco de comentario acima. */
        uint64_t rtAlvoCur = rd_u64(runtime + 0x2548);
        uint64_t rtLocal   = rd_u64(runtime + 0x2528);
        int recusaAlvoAtual = (rtAlvoCur && rtAlvoCur == targetVa);
        int recusaLocal     = (rtLocal && rtLocal == targetVa);

        log_line("attack: shared_ptr {obj=%#llx ctrl=%#llx} "
                 "slot[+0x2528]=%#llx alvo[+0x2548]=%#llx%s%s",
                 (unsigned long long)sp[0], (unsigned long long)sp[1],
                 (unsigned long long)rtLocal, (unsigned long long)rtAlvoCur,
                 recusaAlvoAtual ? " RECUSA=alvo-ja-atual" : "",
                 recusaLocal ? " RECUSA=eh-o-jogador" : "");

        /* Nao chamar quando o handler comprovadamente sai sem atacar: evita
         * gastar o ++ de refcount e devolve um status que o consumidor entende. */
        if (recusaLocal) {
            log_line("attack: alvo %u e' o proprio jogador; nao atacado", targetId);
            return STATUS_BAD_COMMAND;
        }

        typedef uint8_t (*attack_fn)(void *, void *, uint8_t);
        attack_fn f = (attack_fn)(uintptr_t)handler;
        /* 2o arg = &shared_ptr, NAO a entidade.
         * O handler consome a copia (chama o destrutor no epilogo), entao NAO
         * decrementamos depois: o ++ acima apenas paga o -- que ele fara'. */
        uint8_t rc = f((void *)(uintptr_t)runtime, (void *)sp, 0);

        /* o retorno vem da acao real (exe+0x812560), NAO e' booleano.
         *
         * ─── DECIFRADO (2026-11-13, medicao ao vivo de 4 ataques) ───
         *
         * 4 ataques em sequencia, 4 Magnemites a 1 tile, todos hp=100:
         *
         *   alvo #1  devolveu 4   -> HP ficou 100 (RECUSADO)
         *   alvo #2  devolveu 11  -> 100 -> 79 -> 56 -> 8 -> 4  (DANO)
         *   alvo #3  devolveu 11  -> 100 -> 38 -> 36            (DANO)
         *   alvo #4  devolveu 13  -> 100 -> 37                  (DANO)
         *
         * Logo: **4 = recusa**, != 4 = atacou. O 4 e' o mesmo caminho do
         * `cmp rax,[rbx+0x2548] / jne` que decodifiquei: o alvo #1 era o
         * alvo ATUAL do jogo, e o handler saiu sem atacar. Quando o slot
         * estava 0x0 e passamos outro, o golpe conectou.
         *
         * Isto desfaz o que eu tinha escrito antes ("RETORNO 5, 11, 13 -
         * tratamos !=0 como executou"). `!=0` estava errado: 4 tambem e' !=0
         * e significa o oposto. A tabela de valores (4,5,6,7,8,11,13,...)
         * nao e' codigo de acao — o handler devolve um struct em [rsp+0x20]
         * e o EAX e' sobra. O unico valor com significado MEDIDO e' 4.
         *
         * Consequencia para o consumidor: `status 0` (comando entregue) NAO
         * significa acerto. Para saber se acertou, medir o HP do alvo — que
         * e' o que o route-cycle e a UI ja fazem. */
        log_line("attack: handler devolveu %u%s", rc,
                 rc == 4 ? " (4 = RECUSADO)" : "");
        if (rc) {
            g_attackSeq++;
            g_targetId = targetId;
            /* Forca a releitura do alvo AGORA: o consumidor mede o efeito
             * nos proximos 6 s e o scan completo so' roda a cada 8 s.
             * Sem isto, `hpAfter` == `hpBefore` e o relatorio mente
             * dizendo "sem efeito" para um ataque que acertou. */
            refresh_creature_stats(1);
            return STATUS_OK;
        }
        return STATUS_SEND_FAILED;
    }
    /* tipo 6 talk / 7 combo: o texto vai para o consumidor NATIVO do jogo.
     *
     * `talk m1` .. `talk m6` = spellword: o cliente interpreta e dispara a
     * move. `combo !autocombo` = o jogo roda a rotacao configurada nele.
     *
     * CAMINHO NATIVO (2026-11-10) — NAO usa tecla, NAO usa foco:
     *   0x785050(textFn)(rcx=objeto, edx=1, r8d=0, r9=&std::string)
     * O consumidor recarrega os proprios globais e checa os gates de sessao.
     * Ver TEXT_FN_RVA para a evidencia completa.
     *
     * O caminho antigo (PostMessage de WM_CHAR + Enter) exigia primeiro plano
     * e esta' mantido apenas como fallback explicito quando o nativo nao
     * resolve — nunca em silencio.
     *
     * Layout do payload (igual hotkey): len em +8, texto em +24. Os 24 bytes
     * fixos sao uuidHash/expectedAction/attackTargetId. */
    if (type == 6 || type == 7) {
        if (len < 24) return STATUS_BAD_COMMAND;
        uint32_t textLen = 0;
        memcpy(&textLen, payload + 8, 4);
        if (textLen == 0 || textLen > 200 || 24 + textLen > len) return STATUS_BAD_COMMAND;
        const char *text = (const char *)payload + 24;

        /* ─── tipo 7 COMBO: vai para o INTERPRETADOR, nao para o chat ───
         *
         * MEDIDO (2026-11-14): o consumidor 0x785050 e' o CHAT. Mandar
         * "!autocombo" ou "m5" por ele apenas fala no chat — nada dispara.
         * Era o sintoma "usa so' a primeira habilidade": o texto caia no chat
         * e o jogo nunca chamava o interpretador.
         *
         * O interpretador (0x67fbf0) so' aceita o literal "!autocombo"
         * (size==10). A sequencia de skills vem da config do runtime.
         *
         * Tentamos o interpretador PRIMEIRO; se ele nao resolver (build
         * diferente), cai no caminho de texto de sempre para nao perder o
         * comando silenciosamente. */
        if (type == 7) {
            HWND comboHwnd = locate_window();
            if (!comboHwnd) return STATUS_NO_WINDOW;
            int rc = run_combo_in_game_thread(comboHwnd, 1500);
            if (rc == GAME_EXEC_DONE) {
                log_line("combo nativo: \"!autocombo\" disparado no interpretador "
                         "(exe+%#llx); sequencia vem da config",
                         (unsigned long long)COMBO_INTERP_RVA);
                return STATUS_OK;
            }
            if (rc == GAME_EXEC_INDETERMINATE) {
                log_line("combo: INDETERMINADO no interpretador; sem fallback "
                         "para nao duplicar a acao");
                return STATUS_UNSUPPORTED;
            }
            log_line("combo: interpretador nao resolveu; caindo no caminho de texto");
        }

        /* CAMINHO NATIVO PRIMEIRO: mesma funcao que o fornecedor usa.
         * Nao exige foco — e' chamada de funcao na thread do jogo. */
        HWND nativeHwnd = NULL;
        if (resolve_text_path(&nativeHwnd)) {
            int r = run_text_in_game_thread(text, textLen, nativeHwnd, 1500);
            if (r == GAME_EXEC_DONE) {
                log_line("%s nativo: \"%.*s\" despachado na thread do jogo",
                         type == 6 ? "talk" : "combo", (int)textLen, text);
                return STATUS_OK;
            }
            if (r == GAME_EXEC_INDETERMINATE) {
                /* comecou a executar e nao terminou: NAO tentar o teclado,
                 * senao o comando sairia duas vezes */
                log_line("%s nativo: INDETERMINADO; sem fallback para nao duplicar",
                         type == 6 ? "talk" : "combo");
                return STATUS_UNSUPPORTED;
            }
            log_line("%s nativo: hook nao entregou o pedido (motivo=%d); "
                     "avaliando fallback de teclado",
                     type == 6 ? "talk" : "combo", g_textSkipReason);
        }

        HWND hwnd = locate_window();
        if (!hwnd) return STATUS_NO_WINDOW;
        if (background_requested()) {
            log_line("%s recusado: modo background nao suportado",
                     type == 6 ? "talk" : "combo");
            return STATUS_BACKGROUND_UNSUPPORTED;
        }
        if (!require_foreground(hwnd)) {
            log_line("%s: chat EM SEGUNDO PLANO (WM_CHAR mesmo assim)",
                     type == 6 ? "talk" : "combo");
        }
        if (!send_chat_text(hwnd, text, textLen)) {
            log_line("%s: falha ao enviar texto no chat", type == 6 ? "talk" : "combo");
            return STATUS_SEND_FAILED;
        }
        log_line("%s: texto enviado no chat: \"%.*s\"",
                 type == 6 ? "talk" : "combo", (int)textLen, text);
        /* NOTA: `status 0` = texto entregue no chat. Nao significa que o
         * spellword acertou nem que o autocombo completou. O efeito se mede
         * pelo HP do alvo, como no attack. */
        return STATUS_OK;
    }

    /* tipo 8 switchPokemon: NAO existe handler nativo.
     *
     * MEDIDO (2026-11-12): o payload do Shiba nao tem uma funcao de troca de
     * Pokemon. As strings `switchPokemon`, `potion` e `recallPokemon` no dump
     * sao nomes de CONFIG (healer.switchPokemon, hoenn.potionHotkey), nao
     * opcodes de dispatch. O dispatcher nativo tem so' dois modos: attack e
     * follow (`0x15280`, `dl=0`/`dl=1`).
     *
     * Como o Shiba troca de Pokemon: manda o NOME no chat. E' a mesma via do
     * `!autocombo` — o cliente interpreta o texto. Isso e' `talk`, tipo 6.
     *
     * Aqui aceitamos tipo 8 com o mesmo layout de texto do tipo 6 e roteamos
     * para o caminho de texto nativo. O `status 0` significa "texto entregue
     * ao chat", NAO "Pokemon trocado" — a troca se confirma pela telemetria
     * (`pokemonName` mudar).
     *
     * LIMITE: exige texto <= 15 bytes (SSO). Nomes de Pokemon cabem com folga
     * ("Charizard" = 9, "Blastoise" = 9, "Feraligatr" = 10). */
    if (type == 8) {
        if (len < 24) return STATUS_BAD_COMMAND;
        uint32_t nameLen = 0;
        memcpy(&nameLen, payload + 8, 4);
        if (nameLen == 0 || nameLen > 200 || 24 + nameLen > len) return STATUS_BAD_COMMAND;
        const char *name = (const char *)payload + 24;

        HWND nativeHwnd = NULL;
        if (resolve_text_path(&nativeHwnd)) {
            int r = run_text_in_game_thread(name, nameLen, nativeHwnd, 1500);
            if (r == GAME_EXEC_DONE) {
                log_line("switchPokemon nativo: \"%.*s\" enviado no chat",
                         (int)nameLen, name);
                return STATUS_OK;
            }
            if (r == GAME_EXEC_INDETERMINATE) {
                log_line("switchPokemon nativo: INDETERMINADO; sem fallback");
                return STATUS_UNSUPPORTED;
            }
        }
        log_line("switchPokemon: caminho de texto indisponivel; recusado");
        return STATUS_UNSUPPORTED;
    }

    /* tipo 12 potion / 13 revive: tecla da action bar.
     *
     * Nao existe chamada nativa para usar item. O Shiba usa as teclas que o
     * jogador configurou (`hoenn.potionHotkey = "Alt+f"`, `medicineHotkey = "E"`).
     *
     * DOIS FORMATOS ACEITOS, porque o protocolo do cliente manda de formas
     * diferentes conforme o comando:
     *
     *   a) TEXTO (len > 0 em +8): tecla literal, como hotkey. Ex.: "Alt+f".
     *   b) SLOT (u32 em +8, sem texto): numero do slot na action bar (1..50).
     *      Nesse caso mapeamos slot -> tecla de funcao, que e' o que o jogador
     *      pode configurar no jogo (F1..F12).
     *
     * `useWith` (tipo 14) manda o itemId em +8 (u32) e a tecla da bola como
     * texto depois de +24; `recallPokemon` (tipo 15) manda a tecla como texto
     * no formato (a). Ambos caem no mesmo executor de tecla. */
    if (type == 12 || type == 13 || type == 14 || type == 15) {
        if (len < 12) return STATUS_BAD_COMMAND;
        uint32_t textLen = 0;
        memcpy(&textLen, payload + 8, 4);
        uint16_t vk = 0;
        int pgx = 0, pgy = 0, stackSlot = 0;

        int mods = 0;
        if (type == 14) {
            /* itemId ocupou +8; o texto, se houver, vai de +24 ao fim */
            size_t tail = len > 24 ? (size_t)(len - 24) : 0;
            if (tail > 24) {
                log_line("useWith: tecla longa demais (tail=%zu)", tail);
                return STATUS_BAD_COMMAND;
            }
            if (tail) {
                const char *keyText = (const char *)payload + 24;
                if (!parse_key_spec(keyText, (uint32_t)tail, &vk, &mods)) {
                    log_line("useWith: tecla \"%.*s\" nao reconhecida", (int)tail, keyText);
                    return STATUS_BAD_COMMAND;
                }
            }
        } else if (textLen > 0 && textLen <= 24 && 24 + textLen <= len) {
            /* formato (a): tecla literal, com modificadores opcionais */
            const char *keyText = (const char *)payload + 24;
            if (!parse_key_spec(keyText, textLen, &vk, &mods)) {
                log_line("item (tipo %u): tecla \"%.*s\" nao reconhecida",
                         type, (int)textLen, keyText);
                return STATUS_BAD_COMMAND;
            }
        } else if (len >= 12) {
            /* formato (b): slot u32 da action bar -> F1..F12 */
            uint32_t slot = 0;
            memcpy(&slot, payload + 8, 4);
            if (slot < 1 || slot > 12) {
                log_line("item (tipo %u): slot %u fora de 1..12", type, slot);
                return STATUS_BAD_COMMAND;
            }
            vk = (uint16_t)(VK_F1 + (slot - 1));
        } else {
            return STATUS_BAD_COMMAND;
        }

        HWND hwnd = locate_window();
        if (!hwnd) return STATUS_NO_WINDOW;
        /* Mesmo raciocinio do hotkey (tipo 20): `tap_key_with_mods` usa
         * PostMessageA, que funciona sem foco. O gate `require_foreground`
         * fazia pocao e revive devolverem status 5 com o jogo atras — e o
         * autoRevive do Shiba (`hotkey: "f"`) nunca disparava. */
        if (background_requested()) {
            log_line("item (tipo %u) recusado: PKA_EXECUTOR_MODE=background", type);
            return STATUS_BACKGROUND_UNSUPPORTED;
        }
        if (type == 14 && len >= 20) {
            /* captura: aponta o corpo antes da tecla. `pos` vem do encoder em
             * +12; dx/dy sao relativos ao jogador (camera centrada). */
            uint16_t cx = 0, cy = 0;
            memcpy(&cx, payload + 12, 2);
            memcpy(&cy, payload + 14, 2);
            stackSlot = (int)payload[17];
            if (g_havePos) {
                int sx = 0, sy = 0;
                if (project_tile(hwnd, (int32_t)cx - g_posX, (int32_t)cy - g_posY, &sx, &sy)) {
                    pgx = sx; pgy = sy;
                }
            }
            log_line("useWith: corpo id=%u em (%u,%u); clique=(%d,%d)%s",
                     (unsigned)(*((uint32_t *)(payload + 20))), cx, cy, pgx, pgy,
                     (pgx || pgy) ? "" : " SEM_CLIQUE");
            Sleep(40);
        }
        if (vk && !tap_key_with_mods(hwnd, vk, mods)) {
            log_line("item (tipo %u): PostMessage falhou (vk=%u)", type, vk);
            return STATUS_SEND_FAILED;
        }
        log_line("item (tipo %u): vk=%u postada%s", type, vk,
                 GetForegroundWindow() == hwnd ? " (foreground)" : " (SEGUNDO PLANO)");
        *outKey = vk;
        *haveKey = 1;
        log_line("item (tipo %u): vk=%#x mods=%d enviada", type, vk, mods);
        /* useWith: seleciona a bola primeiro e depois aponta o corpo. */
        if (type == 14 && pgx && pgy) {
            /* PKA_USE_BUTTON=r usa clique direito (o atuador de teclado usa
             * direito para atacar); padrao esquerdo. */
            const char *slotEnv = getenv("PKA_BALL_SLOT");
            int slot = slotEnv ? atoi(slotEnv) : 9;
            /* `stack` carrega o slot quando o consumidor quiser outro. */
            /* stack: 1..20 = clicar esse slot da action bar antes; 0 = nao
             * clicar slot (o consumidor ja' selecionou a bola). */
            int skipSlot = (payload[17] == 0);
            if (!skipSlot && stackSlot >= 1 && stackSlot <= 20) slot = stackSlot;
            Sleep(40);
            if (!skipSlot && slot >= 1 && slot <= 20) { click_action_slot(hwnd, slot); Sleep(120); }
            click_client(hwnd, pgx, pgy, 1);
        }
        return STATUS_OK;
    }
    return STATUS_UNSUPPORTED;
}

/* ------------------------------------------------------------ sessao pipe */
static uint8_t g_nonce[NONCE_SIZE];
static uint32_t g_tick = 0;

/* Identidade publicada pela sessao.
 *
 * Medido em native/pka_tap_8036.jsonl: `boot` nasce NO SERVIDOR e aparece no
 * kind 6 (s2c) 51.409 frames antes de qualquer kind 12. O menu so' ecoa esse
 * valor no lease. Por isso a DLL tem que publicar o proprio boot; se ela nao
 * publicar, o cliente e' obrigado a inventar um id que o runtime nao conhece.
 *
 * `client` fica vazio no kind 6: no fornecedor ele vem preenchido so' depois
 * que um menu se registra, e o valor e' do menu — nao nosso. */
static char g_bootId[33];
static char g_clientId[33];
static int g_targetOn = 0;
static int g_walkerOn = 0;
static int g_monitorOn = 0;
static int g_paused = 0;

static void boot_id_init(void)
{
    uint8_t raw[16];
    static const char hex[] = "0123456789abcdef";
    if (g_bootId[0]) return;
    if (BCryptGenRandom(NULL, raw, sizeof raw, BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        for (size_t i = 0; i < sizeof raw; i++) raw[i] = (uint8_t)(rand() & 0xff);
    }
    for (size_t i = 0; i < sizeof raw; i++) {
        g_bootId[i * 2]     = hex[raw[i] >> 4];
        g_bootId[i * 2 + 1] = hex[raw[i] & 0x0f];
    }
    g_bootId[32] = '\0';
}

/* Capacidades declaradas por ESTA DLL.
 *
 * Extensao nossa, explicitamente versionada (`pka-capabilities`), NAO um
 * contrato recuperado do fornecedor. So' entram os tipos que
 * `execute_command` realmente trata (3171 walk, 3240 hotkey, 3292 stop,
 * 3308 attack, 3607/3627 talk+combo, 3709 switchPokemon, 3748 potion).
 *
 * Fora da lista, de proposito:
 *   revive (13)     - protocol.cjs rejeita no encoder; nao e' capacidade nossa
 *   chase (19)      - sem handler; status 4. Declarar aqui repetiria o bug
 *   action/useWith/turn/order/orderGround/follow/focus/fight/refreshCombo/
 *   guildDaily       - sem handler; todos caem em STATUS_UNSUPPORTED (3797)
 */
#define CAP_CONTRACT "pka-capabilities"
#define CAP_VERSION 1
#define CAP_COMMANDS "\"walk\",\"attack\",\"stop\",\"talk\",\"combo\"," \
                     "\"switchPokemon\",\"potion\",\"hotkey\",\"useWith\",\"recallPokemon\""

/* kind 6 (s2c): subconjunto honesto do payload do fornecedor. So' os campos
 * que este runtime realmente conhece; nada de `phase`/`luring` inventados. */
static size_t build_automation(uint8_t *out, size_t cap)
{
    char modules[64] = "";
    char list[80] = "";
    if (g_targetOn) strncat(list, "\"target\"", sizeof list - strlen(list) - 1);
    if (g_walkerOn) {
        if (list[0]) strncat(list, ",", sizeof list - strlen(list) - 1);
        strncat(list, "\"walker\"", sizeof list - strlen(list) - 1);
    }
    snprintf(modules, sizeof modules, "[%s]", list);

    int n = snprintf((char *)out, cap,
        "{\"protocol\":1,\"boot\":\"%s\",\"client\":\"%s\",\"pid\":%d,"
        "\"tick\":%u,\"authorized\":true,\"busy\":false,\"error\":\"\","
        "\"modules\":%s,\"paused\":%s,\"monitor\":{\"enabled\":%s,\"pid\":%d},"
        "\"capabilities\":{\"contract\":\"%s\",\"version\":%d,"
        "\"server\":\"pka_native\",\"commands\":[%s]}}",
        g_bootId, g_clientId, (int)g_targetPid, g_tick, modules,
        g_paused ? "true" : "false", g_monitorOn ? "true" : "false",
        (int)g_targetPid, CAP_CONTRACT, CAP_VERSION, CAP_COMMANDS);
    if (n < 0) return 0;
    if ((size_t)n >= cap) return 0;
    return (size_t)n;
}

/* --- leitura minima de campos JSON do kind 11/12 -------------------------
 * O payload e' JSON plano, sempre com chaves de topo conhecidas. Um parser
 * completo em C aqui so' criaria superficie para divergir do cliente; estes
 * helpers procuram a chave e devolvem o valor. String ausente -> NAO. */
#define JKEY 1
#define JVAL 2

static const char *json_field(const char *json, size_t len, const char *key)
{
    char pat[64];
    int pl = snprintf(pat, sizeof pat, "\"%s\":", key);
    if (pl <= 0 || (size_t)pl >= sizeof pat) return NULL;
    for (size_t i = 0; i + (size_t)pl <= len; i++) {
        if (memcmp(json + i, pat, (size_t)pl) != 0) continue;
        const char *p = json + i + pl;
        while (p < json + len && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
        return p;
    }
    return NULL;
}

/* Copia o valor de string (sem as aspas). Devolve 1 se achou. */
static int json_string(const char *json, size_t len, const char *key, char *out, size_t cap)
{
    const char *p = json_field(json, len, key);
    if (!p || p >= json + len || *p != '"') return 0;
    p++;
    size_t i = 0;
    while (p < json + len && *p != '"' && i + 1 < cap) {
        if (*p == '\\' && p + 1 < json + len) p++;
        out[i++] = *p++;
    }
    out[i] = '\0';
    return 1;
}

static int json_bool(const char *json, size_t len, const char *key, int *out)
{
    const char *p = json_field(json, len, key);
    if (!p) return 0;
    if ((size_t)(json + len - p) >= 4 && memcmp(p, "true", 4) == 0) { *out = 1; return 1; }
    if ((size_t)(json + len - p) >= 5 && memcmp(p, "false", 5) == 0) { *out = 0; return 1; }
    return 0;
}

/* kind 12 (c2s): guarda o `client` declarado. Sem ACK. */
static void lease_note(const uint8_t *payload, size_t len)
{
    char client[64];
    if (json_string((const char *)payload, len, "client", client, sizeof client)
        && strlen(client) == 32) {
        memcpy(g_clientId, client, 33);
    }
    log_line("lease kind12 (%zu bytes)", len);
}

/* kind 11 (c2s): aplica o comando ao estado publicado. Sem ACK — o proximo
 * kind 6 e' a unica prova de aceite que temos, e ele nao prova efeito. */
static void automation_apply(const uint8_t *payload, size_t len)
{
    const char *json = (const char *)payload;
    char op[32] = "";
    char module[32] = "";

    if (!json_string(json, len, "op", op, sizeof op)) {
        log_line("kind11 sem op: ignorado");
        return;
    }
    json_string(json, len, "module", module, sizeof module);

    if (strcmp(op, "start") == 0) {
        if (strcmp(module, "target") == 0) g_targetOn = 1;
        else if (strcmp(module, "walker") == 0) g_walkerOn = 1;
        else { log_line("kind11 start module desconhecido '%s'", module); return; }
        log_line("kind11 start %s", module);
        return;
    }
    if (strcmp(op, "stop") == 0) {
        if (strcmp(module, "target") == 0) g_targetOn = 0;
        else if (strcmp(module, "walker") == 0) g_walkerOn = 0;
        else if (strcmp(module, "hoenn") == 0) { /* nao implementado aqui */ }
        else { log_line("kind11 stop module desconhecido '%s'", module); return; }
        log_line("kind11 stop %s", module);
        return;
    }
    if (strcmp(op, "monitor") == 0) {
        int enabled = 0;
        json_bool(json, len, "enabled", &enabled);
        g_monitorOn = enabled;
        log_line("kind11 monitor %s", enabled ? "on" : "off");
        return;
    }
    if (strcmp(op, "togglePause") == 0) {
        int pause = 0;
        json_bool(json, len, "pauseMonitor", &pause);
        g_paused = pause;
        log_line("kind11 togglePause pause=%d", pause);
        return;
    }
    log_line("kind11 op desconhecido '%s'", op);
}


static DWORD WINAPI session_thread(LPVOID param)
{
    HANDLE pipe = (HANDLE)param;
    uint8_t *buffer = (uint8_t *)malloc(MAX_FRAME + 65536);
    uint8_t *telemetry = (uint8_t *)malloc(MAX_FRAME);
    if (!buffer || !telemetry) {
        free(buffer);
        free(telemetry);
        CloseHandle(pipe);
        return 0;
    }

    uint8_t clientProof[32];
    if (!make_proof(DOMAIN_CLIENT, DOMAIN_LEN, g_nonce, NONCE_SIZE, g_targetPid, clientProof)) {
        log_line("falha ao calcular prova do cliente");
        free(buffer);
        free(telemetry);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 0;
    }

    /* challenge */
    if (!send_frame(pipe, KIND_CHALLENGE, g_nonce, NONCE_SIZE)) {
        log_line("falha ao enviar challenge");
        free(buffer);
        free(telemetry);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 0;
    }

    size_t used = 0;
    int authenticated = 0;
    DWORD lastState = 0, lastTelemetry = 0, lastAutomation = 0;
    DWORD observeMs = observe_interval_ms();
    DWORD lastObserveCheck = 0;

    for (;;) {
        DWORD available = 0;
        if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) break;

        if (available == 0) {
            DWORD now = GetTickCount();
            if (now - lastState >= STATE_INTERVAL_MS) {
                lastState = now;
                uint8_t st[48];
                build_state(st);
                if (!send_frame(pipe, KIND_STATE, st, 48)) break;
            }
            /* Recarrega a cadencia de observacao no maximo 1x/s: permite
             * ajustar pka_observe_hz.txt em runtime sem reinjetar a DLL. */
            if (now - lastObserveCheck >= 1000) {
                lastObserveCheck = now;
                observeMs = observe_interval_ms();
            }
            if (now - lastTelemetry >= observeMs) {
                lastTelemetry = now;
                /* refresh_state() antes de montar o telemetry: sem isso, a
                 * posicao so' seria atualizada pelo scanner_thread a cada 8 s,
                 * e observar a 20 Hz publicaria a MESMA posicao 400 vezes
                 * (medido: 442 amostras, 1 posicao unica). O custo e' uma
                 * leitura de ~0x200 bytes no proprio processo. */
                refresh_state();
                size_t n = build_telemetry(telemetry, MAX_FRAME, ++g_tick);
                if (n && !send_frame(pipe, KIND_TELEMETRY, telemetry, n)) break;
            }
            /* kind 6 a cada ~500 ms: e' de onde o cliente aprende o `boot`
             * (no fornecedor sai ~5x/s). Nao substitui o kind 4. */
            if (authenticated && now - lastAutomation >= AUTOMATION_INTERVAL_MS) {
                lastAutomation = now;
                size_t n = build_automation(telemetry, MAX_FRAME);
                if (n && !send_frame(pipe, KIND_AUTOMATION, telemetry, n)) break;
            }
            Sleep(10);
            continue;
        }

        size_t want = available;
        if (want > MAX_FRAME + 65536 - used) want = MAX_FRAME + 65536 - used;
        if (want == 0) { break; }

        DWORD read = 0;
        if (!ReadFile(pipe, buffer + used, (DWORD)want, &read, NULL)) {
            DWORD err = GetLastError();
            if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED) break;
        }
        used += read;

        size_t offset = 0;
        while (used - offset >= 8) {
            uint32_t len = 0, kind = 0;
            memcpy(&len, buffer + offset, 4);
            memcpy(&kind, buffer + offset + 4, 4);
            if (len > MAX_FRAME) { log_line("frame acima do limite"); goto done; }
            if (used - offset < 8 + len) break;
            const uint8_t *payload = buffer + offset + 8;

            if (kind == KIND_AUTHENTICATE) {
                if (!authenticated) {
                    if (len != 32 || memcmp(payload, clientProof, 32) != 0) {
                        log_line("prova do cliente invalida");
                        goto done;
                    }
                    authenticated = 1;
                    uint8_t welcome[36];
                    uint8_t serverProof[32];
                    if (!make_proof(DOMAIN_SERVER, DOMAIN_LEN, g_nonce, NONCE_SIZE, g_targetPid, serverProof))
                        goto done;
                    memcpy(welcome, &g_targetPid, 4);
                    memcpy(welcome + 4, serverProof, 32);
                    if (!send_frame(pipe, KIND_WELCOME, welcome, 36)) goto done;
                    log_line("canal autenticado pid=%d", g_targetPid);
                    refresh_state();
                    /* Popula criaturas antes do primeiro telemetry.
                     *
                     * ANTES (bug medido): chamava scan_creatures() AQUI, na
                     * thread do pipe. A varredura leva 1-2 s e, se o vtable
                     * ainda estiver sendo resolvido em paralelo, espera ate'
                     * 10 s. O pipe ficava mudo nesse intervalo e o 2o
                     * telemetry chegava 3.546 ms depois do 1o — mais que
                     * MAX_AGE_MS do consumidor. Resultado: snapshot nascia
                     * stale e todo comando era recusado com STALE_SNAPSHOT.
                     *
                     * AGORA: sinaliza o scanner e segue. Se a lista ainda
                     * estiver vazia no primeiro frame, o proximo chega em
                     * ~60 ms com os dados. Melhor um frame vazio do que um
                     * canal travado por segundos. */
                    if (g_layoutResolved && g_scanWakeEvent) SetEvent(g_scanWakeEvent);
                    uint8_t st[48];
                    build_state(st);
                    send_frame(pipe, KIND_STATE, st, 48);
                    size_t n = build_telemetry(telemetry, MAX_FRAME, ++g_tick);
                    if (n) send_frame(pipe, KIND_TELEMETRY, telemetry, n);
                }
            } else if (kind == KIND_MANUAL || kind == KIND_AUTOMATION) {
                uint32_t id = 0, type = 0;
                if (len >= 4) memcpy(&id, payload, 4);
                if (len >= 8) memcpy(&type, payload + 4, 4);
                uint16_t vk = 0;
                int haveKey = 0;
                uint32_t status = execute_command(id, type, payload, len, &vk, &haveKey);
                uint8_t ack[12];
                memcpy(ack + 0, &id, 4);
                memcpy(ack + 4, &type, 4);
                memcpy(ack + 8, &status, 4);
                if (!send_frame(pipe, KIND_ACK, ack, 12)) goto done;
                log_line("comando id=%u tipo=%u status=%u%s", id, type, status,
                         haveKey ? " (tecla)" : "");
            } else if (kind == KIND_AUTOMATION_LEASE) {
                /* kind 12 (c2s): lease de posse do menu. Sem ACK no protocolo.
                 * Guardamos o `client` que o cliente declarou — e' o mapeamento
                 * que o fornecedor publica no kind 6 seguinte. */
                lease_note(payload, len);
            } else if (kind == KIND_AUTOMATION_CONTROL) {
                /* kind 11 (c2s): o canal de comando real. Sem ACK. Registra o
                 * que chegou e devolve no kind 6 (modules/monitor) o que de
                 * fato foi aceito. `effect` continua nao comprovado. */
                automation_apply(payload, len);
            }

            offset += 8 + len;
        }
        if (offset) {
            memmove(buffer, buffer + offset, used - offset);
            used -= offset;
        }
    }

done:
    log_line("sessao encerrada");
    free(buffer);
    free(telemetry);
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}

/* ------------------------------------------------------------------ setup */
static DWORD WINAPI server_thread(LPVOID param)
{
    (void)param;
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof sa;
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = FALSE;

    for (;;) {
        if (stop_signaled()) return 0;
        HANDLE pipe = CreateNamedPipeA(
            g_pipeName,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT_MODE,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER, PIPE_BUFFER, 0, &sa);

        if (pipe == INVALID_HANDLE_VALUE) {
            log_line("CreateNamedPipe falhou: %lu", GetLastError());
            Sleep(200);
            continue;
        }

        /* ConnectNamedPipe com NULL bloqueia indefinidamente. Se o shutdown
         * acontecer aqui, WaitForSingleObject desiste em 3 s e libera o codigo
         * com a thread presa -> 0xC0000005 (visto 2026-11-09).
         *
         * Solucao: coloca o pipe em modo NAO-BLOQUEANTE so' durante o connect
         * e faz polling curto, acordando no evento de parada. Depois volta a
         * modo bloqueante para a sessao (o protocolo depende disso). */
        DWORD origMode = PIPE_READMODE_BYTE | PIPE_WAIT;
        DWORD mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
        SetNamedPipeHandleState(pipe, &mode, NULL, NULL);

        BOOL connected = FALSE;
        for (int spin = 0; spin < 100000; spin++) {
            if (stop_signaled()) {
                CloseHandle(pipe);
                return 0;
            }
            if (ConnectNamedPipe(pipe, NULL)) { connected = TRUE; break; }
            DWORD err = GetLastError();
            if (err == ERROR_PIPE_CONNECTED) { connected = TRUE; break; }
            if (err != ERROR_PIPE_LISTENING) {
                log_line("ConnectNamedPipe erro=%lu", err);
                break;
            }
            if (g_stopEvent) WaitForSingleObject(g_stopEvent, 100);
            else Sleep(100);
        }
        if (!connected) {
            CloseHandle(pipe);
            sleep_or_stop(50);
            continue;
        }

        /* volta a modo bloqueante: a sessao usa ReadFile/WriteFile sincronos */
        SetNamedPipeHandleState(pipe, &origMode, NULL, NULL);

        log_line("cliente conectado");
        for (int i = 0; i < NONCE_SIZE; i++) g_nonce[i] = (uint8_t)(rand() & 0xff);
        BCryptGenRandom(NULL, g_nonce, NONCE_SIZE, BCRYPT_USE_SYSTEM_PREFERRED_RNG);

        g_pipeHandle = pipe;
        HANDLE thread = CreateThread(NULL, 0, session_thread, pipe, 0, NULL);
        if (thread) {
            /* espera a sessao terminar, mas acorda no shutdown */
            while (!stop_signaled() && WaitForSingleObject(thread, 100) == WAIT_TIMEOUT) { }
            if (stop_signaled()) {
                /* ReadFile/WriteFile sincronos na sessao: CancelSynchronousIo
                 * solta o bloqueio; DisconnectNamedPipe ja foi chamado no
                 * shutdown_clean, o que tambem quebra a sessao. */
                CancelSynchronousIo(thread);
                WaitForSingleObject(thread, 2000);
            } else {
                WaitForSingleObject(thread, 2000);
            }
            CloseHandle(thread);
        }
        g_pipeHandle = INVALID_HANDLE_VALUE;
        CloseHandle(pipe);
        if (stop_signaled()) return 0;
    }
    return 0;
}

static DWORD WINAPI scanner_thread(LPVOID param)
{
    (void)param;
    while (!stop_signaled()) {
        /* refresh_state() tenta, em ordem: VA memorizado, vtable do
         * LocalPlayer, cadeia, e por ultimo varredura por nome. Antes este
         * laco chamava find_player() (so nome) e nunca usava o vtable — era
         * por isso que o scanner achava uma copia transiente em vez da
         * entidade. */
        refresh_state();
        /* layout precisa estar resolvido antes de varrer criaturas: o
         * creature_read usa os mesmos offsets do subobjeto base. */
        if (g_layoutResolved && !stop_signaled()) scan_creatures();

        /* Dorme, mas acorda antes em dois casos: shutdown, ou pedido de
         * varredura fresca vindo da sessao (g_scanWakeEvent).
         *
         * POR QUE O SEGUNDO CASO EXISTE (medido 2026-11-12)
         * O handshake chamava scan_creatures() NA PROPRIA THREAD DO PIPE.
         * Essa varredura leva ~1-2 s (e se resolve_monster_vtable ainda
         * estiver resolvendo em outra thread, espera ate' 10 s). Durante
         * ela o servidor nao responde PeekNamedPipe, entao:
         *
         *     t+0ms    cliente conecta e recebe 1 telemetry (do handshake)
         *     t+2000   ainda nao chegou o 2o
         *     t+3500   loop retoma; cadencia normal de 62 ms
         *
         * Medido: 3.546 ms de gap entre o 1o e o 2o frame. O consumidor
         * (NativeSession) tem MAX_AGE_MS = 1500 -> o snapshot nascia
         * ESTRAGADO e o dispatcher recusava com STALE_SNAPSHOT todo comando
         * emitido na primeira tentativa.
         *
         * Correcao: o handshake NAO varre mais; ele SINALIZA. O scanner
         * acorda, varre e o loop continua publicando telemetria. */
        if (g_stopEvent && g_scanWakeEvent) {
            HANDLE waits[2] = { g_stopEvent, g_scanWakeEvent };
            /* Auto-reset: o proprio wait limpa o sinal. Timeout normal. */
            WaitForMultipleObjects(2, waits, FALSE, SCAN_INTERVAL_MS);
        } else {
            sleep_or_stop(SCAN_INTERVAL_MS);
        }
    }
    return 0;
}

static void init_once(void)
{
    /* Guarda de instancia unica POR PROCESSO — sonda do pipe, nao mutex.
     *
     * Por que nao mutex: o handle de um mutex nomeado e' do PROCESSO, nao do
     * modulo. Depois de um unload que nao liberou o handle, o nome continua
     * ocupado para sempre e toda injecao seguinte fica inerte (foi o bug de
     * 2026-11-09). Um pipe nomeado nao sofre disso: quando o servidor morre o
     * pipe desaparece.
     *
     * Sonda: tenta conectar como cliente. Se conectar, ja existe servidor
     * vivo -> esta copia fica inerte. */
    {
        char probeName[128];
        snprintf(probeName, sizeof probeName, "\\\\.\\pipe\\pka-runtime-2-%lu",
                 (unsigned long)GetCurrentProcessId());
        HANDLE probe = CreateFileA(probeName, GENERIC_READ | GENERIC_WRITE, 0,
                                   NULL, OPEN_EXISTING, 0, NULL);
        if (probe != INVALID_HANDLE_VALUE) {
            CloseHandle(probe);
            OutputDebugStringA("pka_native: servidor ja ativo neste processo; esta copia fica inerte");
            return;
        }
    }

    log_open();
    boot_id_init();

    /* evento de parada: acorda scanner_thread e server_thread na hora */
    if (!g_stopEvent) g_stopEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    /* evento de "varredura fresca": a sessao sinaliza em vez de varrer na
     * thread do pipe. Auto-reset (FALSE) — cada SetEvent acorda exatamente
     * um ciclo do scanner. */
    if (!g_scanWakeEvent) g_scanWakeEvent = CreateEventA(NULL, FALSE, FALSE, NULL);

    /* Modo externo: PKA_TARGET_PID aponta para o jogo e a DLL le por
     * ReadProcessMemory em vez de assumir que esta dentro dele. Serve para
     * validar o scanner contra o processo real sem precisar injetar, e
     * funciona a partir do pka_host.exe. */
    const char *target = getenv("PKA_TARGET_PID");
    if (target && *target) {
        int32_t tp = (int32_t)strtol(target, NULL, 10);
        if (tp > 0) {
            HANDLE h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, (DWORD)tp);
            if (!h) {
                log_line("modo externo: OpenProcess(%d) falhou: %lu", tp, GetLastError());
                return;
            }
            g_proc = h;
            g_inProcess = 0;
            g_targetPid = tp;
            resolve_module_base();
            /* PKA_PIPE_SUFFIX permite servir um pipe separado quando o do jogo
             * ja existe (ex.: injetado antes). */
            const char *suffix = getenv("PKA_PIPE_SUFFIX");
            snprintf(g_pipeName, sizeof g_pipeName, "\\\\.\\pipe\\pka-runtime-2-%d%s",
                     g_targetPid, suffix ? suffix : "");
            log_line("modo externo pid=%d pipe=%s", g_targetPid, g_pipeName);
            if (!key_load()) {
                log_line("sem chave: pipe nao sera criado");
                CloseHandle(g_proc);
                g_proc = NULL;
                return;
            }
            g_threads[g_threadCount++] = CreateThread(NULL, 0, scanner_thread, NULL, 0, NULL);
            g_threads[g_threadCount++] = CreateThread(NULL, 0, server_thread, NULL, 0, NULL);
            return;
        }
    }

    g_targetPid = current_pid();
    g_selfPid = GetCurrentProcessId();
    g_inProcess = 1;

    snprintf(g_pipeName, sizeof g_pipeName, "\\\\.\\pipe\\pka-runtime-2-%d", g_targetPid);
    log_line("iniciando pka_native pid=%d pipe=%s", g_targetPid, g_pipeName);

    if (!key_load()) {
        log_line("sem chave: pipe nao sera criado");
        return;
    }

    g_threads[g_threadCount++] = CreateThread(NULL, 0, scanner_thread, NULL, 0, NULL);
    g_threads[g_threadCount++] = CreateThread(NULL, 0, server_thread, NULL, 0, NULL);
    hide_self(g_selfModule);
}

/* Desligamento limpo, chamado em DLL_PROCESS_DETACH.
 *
 * Ordem importa: sinalizar parada, acordar o pipe bloqueado com
 * CancelSynchronousIo, esperar as threads sairem, SO ENTAO o codigo pode ser
 * descarregado. Sem isso, FreeLibrary() derruba o jogo (visto em 2026-11-09).
 *
 * NAO chamar debaixo do loader lock em codigo que faz I/O: por isso o worker
 * que faz o join fica neste laco simples, e o DllMain so sinaliza e espera. */
static void shutdown_clean(void)
{
    /* Chamado de DllMain(DLL_PROCESS_DETACH) — LOADER LOCK TOMADO.
     *
     * So' sinaliza: as threads veem o evento e saem sozinhas no proximo ponto
     * de checagem (scanner_thread, server_thread e dentro de scan_creatures).
     *
     * Esperar aqui travava o processo e, quando estourava, o codigo era
     * liberado com thread viva -> 0xC0000005. Agora esperar e' problema de
     * quem chama o unload.
     *
     * LOG: usa OutputDebugStringA, NAO log_line. log_line faz fopen +
     * EnterCriticalSection, proibidos sob loader lock. Mas sem NENHUM rastro
     * e' impossivel diagnosticar morte por FreeLibrary (aconteceu em
     * 2026-11-09: o log parou sem mensagem). OutputDebugString e' seguro
     * aqui e aparece no DebugView. */
    InterlockedExchange(&g_stop, 1);
    if (g_stopEvent) SetEvent(g_stopEvent);
    if (g_pipeHandle != INVALID_HANDLE_VALUE) DisconnectNamedPipe(g_pipeHandle);
    /* Acorda a thread do hook: ela esta' em GetMessage e so' sai com WM_QUIT. */
    if (g_hookThreadTid) PostThreadMessageW(g_hookThreadTid, WM_QUIT, 0, 0);

    /* CRASH REAL (2026-11-10): FreeLibrary com hook CALLWNDPROC instalado
     * derrubou o cliente. O hook estava na cadeia de outra thread e apontava
     * para game_call_hook, ou seja, para codigo desta DLL. Depois que
     * DllMain(DLL_PROCESS_DETACH) retorna, o loader libera a imagem; a
     * proxima mensagem despachada na thread do jogo chama um endereco que nao
     * e' mais codigo -> 0xC0000005 silencioso, sem entrada no log.
     *
     * UnhookWindowsHookEx e' seguro sob loader lock (nao faz I/O, nao aloca
     * memora de usuario). Remover a entrada da cadeia ANTES de liberar o
     * codigo e' obrigatorio. */
    if (g_hook) {
        UnhookWindowsHookEx(g_hook);
        g_hook = NULL;
        OutputDebugStringA("[pka_native] DETACH: hook removido.");
    }

    OutputDebugStringA("[pka_native] DLL_PROCESS_DETACH: stop sinalizado. "
                       "Se o processo morrer agora, alguma thread nao saiu.");
}

/* modulestomp: o injetor pode chamar export explicitamente em vez de DllMain */
__declspec(dllexport) DWORD WINAPI PkaStart(LPVOID param)
{
    (void)param;
    static LONG started = 0;
    if (InterlockedExchange(&started, 1) == 0) init_once();
    return 0;
}

/* Shutdown ORDENADO, para ser chamado pela thread remota do injetor ANTES do
 * FreeLibrary — portanto FORA do loader lock.
 *
 * WHY (crash medido 2026-11-10, PID 20556): FreeLibrary dispara
 * DllMain(DLL_PROCESS_DETACH) com o loader lock tomado. Ali so' da' para
 * sinalizar; nao da' para esperar as threads sem travar o processo. Quando o
 * FreeLibrary retorna e o loader libera a imagem, qualquer thread nossa que
 * ainda esteja rodando (session/scanner) executa codigo que nao existe mais
 * -> 0xC0000005. O UnhookWindowsHookEx sozinho NAO resolve: tira o hook da
 * cadeia, mas nao espera scanner_thread nem session_thread.
 *
 * Este export faz a sequencia completa sem loader lock:
 *   1. sinaliza parada (threads saem no proximo ponto de checagem)
 *   2. acorda o ConnectNamedPipe/ReadFile bloqueado
 *   3. espera CADA thread terminar, com prazo
 *
 * Depois dele o FreeLibrary e' seguro: nao ha mais codigo nosso executando.
 *
 * Retorna a quantidade de threads que NAO sairam no prazo (0 = seguro). */
__declspec(dllexport) DWORD WINAPI PkaShutdown(LPVOID param)
{
    (void)param;
    DWORD stuck = 0;

    InterlockedExchange(&g_stop, 1);
    if (g_stopEvent) SetEvent(g_stopEvent);
    if (g_pipeHandle != INVALID_HANDLE_VALUE) DisconnectNamedPipe(g_pipeHandle);

    /* Acorda o message loop da thread do hook, bloqueada em GetMessage. Sem
     * isso ela so' sairia no timeout do WaitForSingleObject abaixo. */
    if (g_hookThreadTid) PostThreadMessageW(g_hookThreadTid, WM_QUIT, 0, 0);

    for (int i = 0; i < g_threadCount; i++) {
        HANDLE th = g_threads[i];
        if (!th) continue;
        /* session_thread fica preso em ReadFile sincrono: CancelSynchronousIo
         * solta o bloqueio sem matar a thread. */
        CancelSynchronousIo(th);
        if (WaitForSingleObject(th, 3000) == WAIT_TIMEOUT) {
            stuck++;
            OutputDebugStringA("[pka_native] PkaShutdown: thread nao saiu em 3 s.");
        }
        CloseHandle(th);
        g_threads[i] = NULL;
    }

    /* O hook aponta para o NOSSO codigo. Se a imagem for liberada com ele na
     * cadeia, a proxima mensagem despachada na thread do jogo salta para
     * memoria liberada. Remover aqui tambem (nao so' no detach) e' o que
     * garante a janela segura. */
    if (g_hook) {
        UnhookWindowsHookEx(g_hook);
        g_hook = NULL;
    }
    return stuck;
}

/* Boot fora do loader lock.
 *
 * BUG REAL (2026-11-09, crash 0xC0000005 na injecao):
 * DllMain chamava PkaStart() SINCRONAMENTE. Dentro de DLL_PROCESS_ATTACH o
 * processo esta sob o loader lock, e init_once faz EnumWindows, CreateFileA,
 * malloc/free, VirtualQueryEx e CreateThread. Trabalho assim sob loader lock
 * deadlocka ou crasha — o LoadLibraryA remoto voltou 0xC0000005.
 *
 * Correcao: DllMain so' cria esta thread e retorna TRUE. Todo o trabalho
 * pesado acontece aqui, sem lock nenhum. */
static DWORD WINAPI boot_thread(LPVOID param)
{
    (void)param;
    PkaStart(NULL);
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)inst;
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        g_selfModule = inst;
        cache_module_dir(inst);
        /* NUNCA fazer I/O aqui. So' dispara a thread de boot. */
        HANDLE t = CreateThread(NULL, 0, boot_thread, NULL, 0, NULL);
        if (t) CloseHandle(t);
    } else if (reason == DLL_PROCESS_DETACH) {
        /* reserved != NULL => o processo esta terminando; nao mexe em nada */
        if (!reserved) shutdown_clean();
    }
    return TRUE;
}

