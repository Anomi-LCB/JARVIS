/** Preserve explicitly quoted search folders without confusing folder names with file targets.
 * This parses user text only; adapters and policy still enforce path authority. */
export function parseSearchDirectoryRequest(text) {
  const raw = String(text);
  const pattern = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’)\s*(?:폴더|디렉토리)\s*(?:안에서|내에서|에서|와|과|(?=\s*(?:및|그리고|,)))/gu;
  const declarations = [...raw.matchAll(pattern)].map(match => ({
    path: match[1] ?? match[2] ?? match[3] ?? match[4], start: match.index, end: match.index + match[0].length
  }));
  let remainingText = raw;
  for (const declaration of [...declarations].reverse()) {
    remainingText = remainingText.slice(0, declaration.start) + ' '.repeat(declaration.end - declaration.start) + remainingText.slice(declaration.end);
  }
  return { declarations, remainingText };
}
