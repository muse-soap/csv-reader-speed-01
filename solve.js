// A fast drop-in replacement for csv-reader 1.0.0's readCsv, returning the identical
// {columns, rows, errors} for every input, including every broken-row policy:
// BOM drop, stray CRs, quoted fields with "" escapes, CR/CRLF inside quotes read as LF,
// quote junk after a closing quote, unterminated quotes re-read as unquoted text,
// empty lines skipped, and rows padded or cut to the first record's width.
//
// Strategy: one left-to-right pass that finds field boundaries with indexOf and takes
// each field as a single slice wherever the text allows it; only the rare broken
// segments (stray CRs, line breaks inside quotes, escaped quotes) take a slower path.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line break.
  // Returns [value, ended, added]: added counts the characters kept from the text
  // (the prefix is not counted), as the reference's readUnquoted counts them.
  function readUnquoted(prefix) {
    let parts = null;
    let segStart = pos;
    let added = 0;
    for (;;) {
      // Nearest of , \n \r at or after pos.
      let j = -1;
      let kind = -1;
      const cComma = text.indexOf(',', pos);
      const cLf = text.indexOf('\n', pos);
      const cCr = text.indexOf('\r', pos);
      if (cComma !== -1) { j = cComma; kind = 44; }
      if (cLf !== -1 && (j === -1 || cLf < j)) { j = cLf; kind = 10; }
      if (cCr !== -1 && (j === -1 || cCr < j)) { j = cCr; kind = 13; }
      if (j === -1) {
        added += len - segStart;
        const tail = text.slice(segStart, len);
        pos = len;
        return [parts ? prefix + parts.join('') + tail : prefix + tail, END, added];
      }
      if (kind === 44) {
        added += j - segStart;
        const tail = text.slice(segStart, j);
        pos = j + 1;
        return [parts ? prefix + parts.join('') + tail : prefix + tail, COMMA, added];
      }
      if (kind === 10) {
        added += j - segStart;
        const tail = text.slice(segStart, j);
        pos = j + 1;
        line += 1;
        return [parts ? prefix + parts.join('') + tail : prefix + tail, LINE_BREAK, added];
      }
      // kind === 13: a CR.
      if (j + 1 < len && text.charCodeAt(j + 1) === 10) {
        added += j - segStart;
        const tail = text.slice(segStart, j);
        pos = j + 2;
        line += 1;
        return [parts ? prefix + parts.join('') + tail : prefix + tail, LINE_BREAK, added];
      }
      // A stray CR: dropped, with an error, and the field goes on.
      pushError('stray_cr');
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, j));
      added += j - segStart;
      pos = j + 1;
      segStart = pos;
    }
  }

  // A quoted segment's text with each CRLF or lone CR read as LF, and the line
  // advanced by the number of line breaks it held. Plain segments return as-is.
  function quotedSegment(s) {
    if (s.indexOf('\r') === -1) {
      // Only LFs to count.
      let idx = s.indexOf('\n');
      if (idx === -1) return s;
      let count = 0;
      while (idx !== -1) {
        count += 1;
        idx = s.indexOf('\n', idx + 1);
      }
      line += count;
      return s;
    }
    let count = 0;
    let idx = -1;
    const re = /\r\n|\r|\n/g;
    let m;
    while ((m = re.exec(s)) !== null) count += 1;
    line += count;
    return s.replace(/\r\n|\r/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns [value, ended].
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let parts = null;
    let segStart = pos;
    let value = null;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        const r = readUnquoted('"');
        return [r[0], r[1]];
      }
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote, and the field goes on.
        if (parts === null) parts = [];
        parts.push(quotedSegment(text.slice(segStart, q)));
        parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      const seg = quotedSegment(text.slice(segStart, q));
      value = parts ? parts.join('') + seg : seg;
      pos = q + 1;
      break;
    }
    if (pos >= len) return [value, END];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, COMMA];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, LINE_BREAK];
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK];
    }
    // What follows the closing quote is appended as it stands.
    const junk = readUnquoted(value);
    if (junk[2] > 0) pushError('quote_junk');
    return [junk[0], junk[1]];
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      if (quoted) {
        const r = readQuoted();
        fields.push(r[0]);
        ended = r[1];
      } else {
        const r = readUnquoted('');
        fields.push(r[0]);
        ended = r[1];
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
