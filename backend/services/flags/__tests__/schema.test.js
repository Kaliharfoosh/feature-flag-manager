const { parseUpdateBody } = require('../schema');

test('trims metadata and strips immutable or server-owned inputs', () => {
  expect(parseUpdateBody({ name: '  Revised name  ', description: '  Details  ', version: 3, key: 'different-key', teamId: 'other-team', id: 'other-id' }))
    .toEqual({ name: 'Revised name', description: 'Details', version: 3 });
});

test.each([
  { version: 1 },
  { name: '   ', version: 1 },
  { name: 'Valid', version: '1' },
  { name: 'Valid', version: 0 },
  { description: 'x'.repeat(501), version: 1 },
  { archived: 'true', version: 1 },
])('rejects invalid metadata writes', (body) => {
  expect(() => parseUpdateBody(body)).toThrow(expect.objectContaining({ status: 400, code: 'VALIDATION_ERROR' }));
});

test('supports clearing a description and explicitly restoring a flag', () => {
  expect(parseUpdateBody({ description: '', archived: false, version: 2 })).toEqual({ description: '', archived: false, version: 2 });
});
