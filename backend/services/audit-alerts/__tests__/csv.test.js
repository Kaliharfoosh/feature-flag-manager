const csv = require('../csv');

const event = (extra = {}) => ({
  id: 1, at: new Date('2026-11-13T14:05:00.000Z'), actorLabel: 'dev@acme.test', category: 'change',
  action: 'flag.updated', targetType: 'flag', targetId: 'f1', requestId: 'r1',
  details: { after: { name: 'Checkout' } }, ...extra,
});

describe('cell: CSV formula injection (ST-17, AUD-11)', () => {
  test.each(['=HYPERLINK("http://evil","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])(
    '%j gets a leading apostrophe', (value) => {
      expect(csv.cell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
    },
  );

  test('ordinary text is unchanged, just quoted', () => {
    expect(csv.cell('dev@acme.test')).toBe('"dev@acme.test"');
    expect(csv.cell('a=b')).toBe('"a=b"');
  });

  test('quotes, commas and line breaks stay inside the cell', () => {
    expect(csv.cell('say "hi", then\nleave')).toBe('"say ""hi"", then\nleave"');
  });

  test('null, dates and objects', () => {
    expect(csv.cell(null)).toBe('""');
    expect(csv.cell(new Date('2026-11-13T14:05:00.000Z'))).toBe('"2026-11-13T14:05:00.000Z"');
    expect(csv.cell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('toCsv', () => {
  test('header plus one row per event, CRLF line endings', () => {
    const out = csv.toCsv([event(), event({ id: 2, action: 'flag.created' })]);
    const lines = out.split('\r\n');
    expect(lines[0]).toBe('at,actor,category,action,targetType,targetId,requestId,details');
    expect(lines[1]).toBe('"2026-11-13T14:05:00.000Z","dev@acme.test","change","flag.updated","flag","f1","r1","{""after"":{""name"":""Checkout""}}"');
    expect(lines).toHaveLength(4); // header, 2 rows, trailing empty after the last CRLF
  });

  test('a malicious value in any column is neutralised', () => {
    const out = csv.toCsv([event({ actorLabel: '=cmd|"/c calc"!A1' })]);
    expect(out).toContain(`"'=cmd|""/c calc""!A1"`);
  });

  test('no events gives just the header', () => {
    expect(csv.toCsv([])).toBe(`${csv.COLUMNS.join(',')}\r\n`);
  });
});

describe('filename', () => {
  test('uses the filter dates, showing the inclusive last day', () => {
    expect(csv.filename({ from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z') }))
      .toBe('audit-2026-11-01-2026-11-02.csv');
  });

  test('open-ended', () => {
    expect(csv.filename({})).toBe('audit-start-now.csv');
  });
});
