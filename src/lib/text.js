const FILLERS = /\b(u+h+m*|u+m+|e+r+m+|a+h+|hmm+|mm+|you know|i mean|kind of|sort of|basically|literally)\b[,]?\s*/gi;
const LEADING_MARKERS = /^((yeah|okay|ok|so|well|alright|like|and|right)[,.]?\s+)+/i;
const TRAILING_MARKERS = /[,\s]+(okay|ok|right|yeah|you know)[.?!]*$/i;

export function cleanSentence(raw) {
  let t = ` ${raw ?? ''} `.replace(FILLERS, ' ');
  t = t.replace(/\bmaybe\s+/gi, '');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(LEADING_MARKERS, '');
  t = t.replace(TRAILING_MARKERS, '');
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, '$1'); // "the the"
  t = t.replace(/\s+([,.!?;:])/g, '$1').replace(/,+/g, ',').replace(/^[,.\s]+/, '');
  t = t.replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|ve|d)\b/gi, (_, s) => `I'${s.toLowerCase()}`);
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase());
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

export function speakerLabel(n) {
  const i = Number(n) || 0;
  return i < 26 ? `Speaker ${String.fromCharCode(65 + i)}` : `Speaker ${i + 1}`;
}

export function wordCount(text) {
  return (text.match(/\S+/g) ?? []).length;
}
