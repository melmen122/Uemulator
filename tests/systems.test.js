'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSystem, coreForSystem, coresForSystem } = require('../src/main/systems');

const TABLE = {
  n64: ['.z64', '.n64', '.v64'],
  switch: ['.nsp', '.xci', '.nca', '.nro'],
  '3ds': ['.3ds', '.cci', '.cxi', '.cia', '.3dsx', '.app'],
  gba: ['.gba'],
  gbc: ['.gbc'],
  gb: ['.gb'],
};

for (const [sys, exts] of Object.entries(TABLE)) {
  test(`detectSystem maps ${sys} extensions (any case)`, () => {
    for (const ext of exts) {
      assert.equal(detectSystem(`/roms/Game${ext}`), sys, ext);
      assert.equal(detectSystem(`/roms/Game${ext.toUpperCase()}`), sys, ext.toUpperCase());
    }
  });
}

test('detectSystem returns null for unknown, missing, or non-string input', () => {
  assert.equal(detectSystem('/roms/readme.txt'), null);
  assert.equal(detectSystem('/roms/noext'), null);
  assert.equal(detectSystem('/roms/.gba'), null); // dotfile, not an extension
  assert.equal(detectSystem('/roms/game.gba.bak'), null);
  assert.equal(detectSystem(''), null);
  assert.equal(detectSystem(null), null);
  assert.equal(detectSystem(42), null);
});

test('detectSystem uses only the last extension', () => {
  assert.equal(detectSystem('/a.b/game.v64'), 'n64');
  assert.equal(detectSystem('/a.gba/game'), null);
});

test('coreForSystem defaults', () => {
  assert.equal(coreForSystem('n64', {}), 'project64');
  assert.equal(coreForSystem('switch', {}), 'ryujinx');
  assert.equal(coreForSystem('3ds', {}), 'azahar');
  assert.equal(coreForSystem('gba', {}), 'mgba');
  assert.equal(coreForSystem('gb', { gbCore: 'mgba' }), 'mgba');
  assert.equal(coreForSystem('gbc', undefined), 'mgba');
});

test('coreForSystem honors gbCore for gb/gbc only', () => {
  assert.equal(coreForSystem('gb', { gbCore: 'pyboy' }), 'pyboy');
  assert.equal(coreForSystem('gbc', { gbCore: 'pyboy' }), 'pyboy');
  assert.equal(coreForSystem('gba', { gbCore: 'pyboy' }), 'mgba');
  assert.equal(coreForSystem('n64', { gbCore: 'pyboy' }), 'project64');
});

test('coreForSystem ignores bogus gbCore and unknown system', () => {
  assert.equal(coreForSystem('gb', { gbCore: 'evil' }), 'mgba');
  assert.equal(coreForSystem('nes', {}), null);
});

test('coresForSystem lists capable cores', () => {
  assert.deepEqual(coresForSystem('gb'), ['mgba', 'pyboy']);
  assert.deepEqual(coresForSystem('gba'), ['mgba']);
  assert.deepEqual(coresForSystem('zzz'), []);
});
