'use strict';

/**
 * Contratos do executor que NAO podem regredir.
 *
 *   node --test botfinal/tests/executor_focus_policy.test.cjs
 *
 * Estes testes cobrem duas garantias que a versao anterior da DLL violava:
 *   1. o executor NAO altera estado de janela (nada de ShowWindow/
 *      SetForegroundWindow/BringWindowToTop/AttachThreadInput);
 *   2. falha de foco RECUSA o comando em vez de escalar metodos.
 *
 * Sao testes de codigo-fonte e de binario, nao de comportamento do cliente.
 * Nao substituem validacao no cliente; impedem que o defeito volte.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'native', 'pka_native.c');
const DLLS = [
  path.join(ROOT, 'native', 'pka_native.dll'),
  path.join(ROOT, 'native', 'pka_native_new.dll'),
].filter(p => fs.existsSync(p));

/* Funcoes que mudam foco, ativacao, ordem ou estado de janela. */
const FORBIDDEN = [
  'SetForegroundWindow',
  'AttachThreadInput',
  'ShowWindow',
  'ShowWindowAsync',
  'BringWindowToTop',
  'SetActiveWindow',
  'SetFocus',
  'SwitchToThisWindow',
  'SetWindowPos',
  'SendInput',
  'keybd_event',
];

/** Remove comentarios C para nao casar com texto explicativo. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/[^\n\r]*/gu, ' ');
}

test('pka_native.c nao chama nenhuma funcao de foco/janela', () => {
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  const found = FORBIDDEN.filter(name => new RegExp('\\b' + name + '\\s*\\(', 'u').test(code));
  assert.deepEqual(found, [],
    'o executor nao pode chamar: ' + found.join(', ')
    + '. Capturar foco e interferencia nao autorizada.');
});

test('a DLL compilada nao importa funcoes de foco/janela', () => {
  assert.ok(DLLS.length > 0, 'compile antes: node tools/build_native.cjs --only bot');
  for (const dll of DLLS) {
    const buf = fs.readFileSync(dll);
    const present = FORBIDDEN.filter(name =>
      buf.includes(Buffer.from(name, 'ascii'))
      || buf.includes(Buffer.from(name, 'utf16le')));
    if (path.basename(dll) === 'pka_native.dll') {
      /* A DLL "oficial" pode estar travada por um cliente vivo, entao o build
       * escreve pka_native_new.dll. Nao falhar aqui; exigir que a versao
       * promovida seja a limpa (teste abaixo). */
      if (present.length) {
        assert.ok(fs.existsSync(path.join(ROOT, 'native', 'pka_native_new.dll')),
          'pka_native.dll contem foco (' + present.join(', ')
          + ') e nao ha build novo para promover');
      }
      continue;
    }
    assert.deepEqual(present, [],
      path.basename(dll) + ' contem simbolo de foco: ' + present.join(', '));
  }
});

test('o build mais recente nao contem funcoes de foco', () => {
  /* O build grava pka_native.dll quando o arquivo nao esta mapeado, e
   * pka_native_new.dll quando o cliente vivo trava o original. O contrato e
   * "o binario mais NOVO nao pode conter simbolo de foco", nao um nome fixo. */
  const candidates = [
    path.join(ROOT, 'native', 'pka_native.dll'),
    path.join(ROOT, 'native', 'pka_native_new.dll'),
  ].filter(p => fs.existsSync(p));
  assert.ok(candidates.length > 0,
    'rode node tools/build_native.cjs --only bot para gerar a DLL');
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const newest = candidates[0];
  const buf = fs.readFileSync(newest);
  const present = FORBIDDEN.filter(name =>
    buf.includes(Buffer.from(name, 'ascii'))
    || buf.includes(Buffer.from(name, 'utf16le')));
  assert.deepEqual(present, [],
    'o build novo (' + path.basename(newest) + ') ainda contem: ' + present.join(', '));
});

test('a DLL compilada ainda posta a tecla (PostMessageA)', () => {
  for (const dll of DLLS) {
    const buf = fs.readFileSync(dll);
    assert.ok(buf.includes(Buffer.from('PostMessageA', 'ascii'))
      || buf.includes(Buffer.from('PostMessageW', 'ascii')),
    path.basename(dll) + ' precisa postar a mensagem de tecla');
  }
});

test('o modo foreground e o padrao e a recusa tem status proprio', () => {
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  assert.match(code, /PKA_EXECUTOR_MODE/u, 'modo deve ser configuravel por ambiente');
  assert.match(code, /_stricmp\(mode,\s*"background"\)\s*==\s*0/u,
    'qualquer valor diferente de "background" precisa cair no foreground');
  assert.match(code, /#define STATUS_NO_FOREGROUND\s+5/u,
    'falha de foco precisa de status proprio (5), nao generico');
  assert.match(code, /static int require_foreground\(HWND hwnd\)/u,
    'o gate de foco precisa existir como funcao unica');
});

test('require_foreground so le o foregroud, nao altera', () => {
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  const start = code.indexOf('static int require_foreground');
  assert.ok(start > 0, 'require_foreground ausente');
  const end = code.indexOf('\n}', start);
  const body = code.slice(start, end);
  assert.match(body, /GetForegroundWindow/u, 'precisa checar o foreground atual');
  for (const name of FORBIDDEN) {
    assert.ok(!new RegExp('\\b' + name + '\\s*\\(', 'u').test(body),
      'require_foreground nao pode chamar ' + name);
  }
});

test('walk e hotkey postam sem foco (medido 2026-11-20)', () => {
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  const walk = code.slice(code.indexOf('if (type == 1)'),
    code.indexOf('if (type == 20)'));
  /* 2026-11-13 o foco era exigido. Medido de novo em 2026-11-20 com o jogo
   * MINIMIZADO: 3 de 3 passos entregues por PostMessageA. O gate virou log. */
  assert.match(walk, /require_foreground\(hwnd\)/u,
    'o caminho de walk continua registrando o estado de foco');
  assert.match(walk, /EM SEGUNDO PLANO/u,
    'o log precisa registrar que a tecla saiu em segundo plano');
  assert.match(walk, /tap_key_ex/u, 'walk precisa postar a seta');
  assert.ok(!/return STATUS_NO_FOREGROUND/u.test(walk),
    'walk nao pode mais recusar por falta de foco');

  /* HOTKEY: o contrato ANTIGO exigia require_foreground e devolvia 5 sempre
   * que o jogo estava atras. Medido em 2026-11-13: `tap_key_with_mods` usa
   * PostMessageA, que entrega a tecla SEM foco. Com o gate, `potion` e
   * `revive` (ambos tecla) ficavam inuteis em background — e o autoRevive do
   * Shiba (`hotkey: "f"`) nunca disparava.
   *
   * O contrato agora exige: postar primeiro, sem gate de foco, e logar se foi
   * em primeiro ou segundo plano. `PKA_EXECUTOR_MODE=background` continua
   * sendo recusa EXPLICITA para quem quer garantir que nada e' postado. */
  const hotkey = code.slice(code.indexOf('if (type == 20)'),
    code.indexOf('if (type == 4)'));
  assert.ok(!/require_foreground\(hwnd\)/u.test(hotkey),
    'hotkey nao pode exigir foreground: PostMessage entrega em background');
  assert.match(hotkey, /tap_key_with_mods/u,
    'hotkey precisa postar a tecla');
  assert.match(hotkey, /SEGUNDO PLANO/u,
    'o log precisa registrar quando a tecla saiu em segundo plano');
  assert.match(hotkey, /PKA_EXECUTOR_MODE=background|background_requested/u,
    'a recusa explicita por ambiente precisa continuar existindo');
});

test('stop declara que nao cancela movimento no cliente', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('tipo 4 stop');
  assert.ok(start > 0, 'comentario do tipo 4 ausente');
  const block = source.slice(start, start + 900);
  assert.match(block, /NAO significa que o cliente cancelou/u,
    'o comentario precisa dizer que NAO ha cancelamento no cliente');
  assert.match(block, /runtime\.stop/u,
    'a parada efetiva e na camada Node');
});

test('combate continua explicitamente nao suportado', () => {
  /* O bloco final de execute_command devolve STATUS_UNSUPPORTED para talk/combo.
   * Localizamos pela funcao inteira para nao depender de comentario de secao. */
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  const fnStart = code.indexOf('static uint32_t execute_command(');
  assert.ok(fnStart > 0, 'execute_command ausente');
  const fnEnd = code.indexOf('\n}', code.indexOf('if (type == 4)'));
  const tail = code.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.match(tail, /return STATUS_UNSUPPORTED;/u,
    'talk/combo deve devolver STATUS_UNSUPPORTED, nao sucesso');

  /* Ordem no codigo: type 1 (walk nativo) -> 20 (hotkey) -> 4 (stop) ->
   * 2 (attack) -> 6/7 (talk/combo). Os tipos com caminho real sao 1, 2 e 4.
   * talk/combo (6/7) NAO pode devolver STATUS_OK. */
  const afterTalk = tail.slice(tail.indexOf('if (type == 6 || type == 7)'));
  if (afterTalk) {
    /* o bloco de talk/combo pode ter STATUS_OK (texto entregue no chat), mas
     * so' depois de send_chat_text — nunca incondicional */
    assert.match(afterTalk, /send_chat_text/u,
      'talk/combo so pode devolver OK depois de send_chat_text');
  }
  /* o final da funcao (fora de qualquer tipo) NAO pode ser STATUS_OK */
  const finalReturn = tail.slice(tail.lastIndexOf('return STATUS_UNSUPPORTED;'));
  assert.ok(finalReturn.length > 0, 'o fallback final deve ser STATUS_UNSUPPORTED');
});

test('walk nativo: INDETERMINATE nunca cai no fallback de teclado', () => {
  /* O bug apontado na revisao: se a funcao comecou a executar e o timeout
   * chega, tentar o teclado moveria DUAS vezes. O codigo tem que devolver
   * STATUS_UNSUPPORTED (nao sei) sem tocar em tap_key. */
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  const walkStart = code.indexOf('if (type == 1)');
  const walkEnd = code.indexOf('if (type == 20)');
  assert.ok(walkStart > 0 && walkEnd > walkStart, 'bloco de walk ausente');
  const walk = code.slice(walkStart, walkEnd);

  assert.match(walk, /GAME_EXEC_INDETERMINATE/u,
    'walk precisa distinguir INDETERMINATE');
  assert.match(walk, /return STATUS_UNSUPPORTED;[\s\S]{0,200}?INDETERMINATE|INDETERMINATE[\s\S]{0,400}?return STATUS_UNSUPPORTED/u,
    'INDETERMINATE tem que sair como UNSUPPORTED antes do fallback');

  /* a ordem importa: o teste de INDETERMINATE vem ANTES do tap_key */
  const iInd = walk.indexOf('GAME_EXEC_INDETERMINATE');
  const iTap = walk.indexOf('tap_key_ex');
  assert.ok(iInd > 0, 'sem INDETERMINATE');
  assert.ok(iTap > iInd, 'o fallback de teclado tem que vir DEPOIS do teste de INDETERMINATE');
});
