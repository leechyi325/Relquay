import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalText, savedCommands, commandHistory } from '../shared/terminal';

test('terminal copy joins soft wraps while retaining real line breaks and boundary spaces', () => {
  const rows = [
    ['echo "long ', false], ['command"   ', true], ['first line  ', false],
    ['second line ', false], ['', false], ['', false],
  ] as const;
  const buffer = { length: rows.length, getLine: (i: number) => rows[i] && ({ isWrapped: rows[i][1], translateToString: (trim?: boolean) => trim ? rows[i][0].trimEnd() : rows[i][0] }) };
  assert.equal(terminalText(buffer), 'echo "long command"\nfirst line\nsecond line');
  assert.equal(terminalText({ length: 0, getLine: () => undefined }), '');
  assert.equal(terminalText({ length: 2, getLine: () => ({ isWrapped: false, translateToString: () => '' }) }), '');
});

test('shortcut storage handles defaults, deletion, corruption, duplicate ids and multiline commands', () => {
  assert.equal(savedCommands(null).length, 5);
  assert.equal(savedCommands('{').length, 5);
  assert.deepEqual(savedCommands('[]'), []);
  const valid = { id: 'one', name: '检查', command: 'pwd\nfree -h' };
  assert.deepEqual(savedCommands(JSON.stringify([valid, valid, null, { id: 'bad' }, { ...valid, id: 'two', command: '' }])), [valid]);
  const defaults = savedCommands(null); defaults[0].command = 'changed';
  assert.equal(savedCommands(null)[0].command, 'pwd');
  assert.deepEqual(commandHistory('corrupt'), []);
  assert.deepEqual(commandHistory('{"value":"x"}'), []);
  assert.deepEqual(commandHistory('["pwd",null,4,""]'), ['pwd']);
});
