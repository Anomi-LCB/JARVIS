// Model output is data: only tool arguments cross this boundary, never policy,
// grants, approval state, capability tokens or an alternate tool name.
export const missionArgumentFields = {
  'filesystem.createTextFile': ['path','content','allowOverwrite','expectedSha256'],
  'filesystem.listFiles': ['directory','maxItems','offset','expectedListingSha256'],
  'filesystem.searchFiles': ['query','directory','directories','scope','extensions','maxResults','contentQuery'],
  'filesystem.readText': ['path','offset','maxChars'],
  'document.readPdf':['path','firstPage','maxPages','expectedSha256'],
  'filesystem.previewMoveFiles': ['moves','from','to'],
  'filesystem.moveFiles': ['moves','from','to'],
  'shell.execute': ['command','verifyCommand'],
  'excel.createWorkbook': ['outputPath','sheetName','columns','rows','style','charts','sheets','renderPdf','pdfOutputPath'],
  'excel.readWorkbook':['path','sheetName','range','expectedSha256'],
  'excel.exportPdf':['inputPath','outputPath','expectedSha256'],
  'word.create': ['path','title','blocks','outputFormat'],
  'hwp.create': ['path','title','blocks','verifyRendering'],
  'weather.createHwpReport': ['location','weatherLocation','path','fileName','targetDirectoryHint','verifyRendering'],
  'macro.save':['rawText'],
  'powerpoint.create': ['path','deckTitle','slides','outputFormat'],
  'document.edit': ['targetPath','edits','sheet'],
  'visual.createCards': ['outputDirectory','width','height','cards'],
  'archive.createZip': ['path','inputPaths','inputs'],
  'email.send': ['to','recipientMode','subject','body','attachmentQuery','attachmentPath','attachmentSha256','attachmentRef','attachments','idempotencyKey'],
  'browser.search': ['query','maxResults','searchEngine'],
  'news.fetchHeadlines': ['query','category','maxResults'],
  'news.fetchPublisherFeed': ['feedUrl','maxResults'],
  'news.fetchArticle': ['url']
};

// Capability packages extend this boundary at runtime only after their skill,
// adapter, evidence schema and verifier have passed one atomic preflight.  The
// registration is idempotent so isolated runtimes in tests can activate the
// same signed package without widening one another's argument surface.
export function registerMissionArgumentSchema(toolName, fields) {
  const normalizedToolName = String(toolName ?? '').trim();
  const normalizedFields = [...new Set((fields ?? []).map((field) => String(field ?? '').trim()).filter(Boolean))];
  if (!normalizedToolName || normalizedFields.length === 0 || normalizedFields.some((field) => !/^[A-Za-z][A-Za-z0-9]*$/u.test(field))) {
    const error = new Error('Mission argument schema registration is invalid.');
    error.code = 'A_MISSION_ARGUMENT_SCHEMA_INVALID';
    throw error;
  }
  const existing = missionArgumentFields[normalizedToolName];
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(normalizedFields)) {
      const error = new Error(`Mission argument schema conflict for ${normalizedToolName}.`);
      error.code = 'A_MISSION_ARGUMENT_SCHEMA_CONFLICT';
      throw error;
    }
    return existing;
  }
  missionArgumentFields[normalizedToolName] = Object.freeze(normalizedFields);
  return missionArgumentFields[normalizedToolName];
}

export function snapshotMissionArgumentSchemas() {
  return {
    snapshotVersion: 'a-mission-argument-schemas-snapshot-v1',
    schemas: Object.entries(missionArgumentFields).map(([toolName, fields]) => [toolName, [...fields]])
  };
}

export function restoreMissionArgumentSchemas(snapshot) {
  if (snapshot?.snapshotVersion !== 'a-mission-argument-schemas-snapshot-v1'
    || !Array.isArray(snapshot.schemas)
    || snapshot.schemas.some((entry) => !Array.isArray(entry)
      || entry.length !== 2
      || typeof entry[0] !== 'string'
      || !Array.isArray(entry[1]))) {
    const error = new Error('Mission argument schema snapshot is invalid.');
    error.code = 'A_MISSION_ARGUMENT_SCHEMA_SNAPSHOT_INVALID';
    throw error;
  }
  for (const toolName of Object.keys(missionArgumentFields)) delete missionArgumentFields[toolName];
  for (const [toolName, fields] of snapshot.schemas) {
    missionArgumentFields[toolName] = Object.freeze([...fields]);
  }
}

// CapabilityPackageRegistry keeps the callable registration API, while these
// hooks let it compensate a registrar that mutates state before throwing.
Object.defineProperties(registerMissionArgumentSchema, {
  snapshot: { value: snapshotMissionArgumentSchemas },
  restore: { value: restoreMissionArgumentSchemas }
});

// The mission planner occasionally names a table's header row `headers`, while
// the local document adapters use `columns`.  Canonicalize the alias at the
// trusted model-data boundary so a valid table cannot be silently discarded by
// a downstream adapter.  Keep every other block field intact here: the adapter
// remains responsible for validating its own block schema and rejecting an
// unsupported block rather than losing user content.
function canonicalizeDocumentTableHeaders(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    if (String(block.type ?? '').toLowerCase() !== 'table') return block;
    if (Array.isArray(block.columns)) {
      const { headers: alternateHeaders, ...canonical } = block;
      return canonical.columns.length === 0 && Array.isArray(alternateHeaders) && alternateHeaders.length > 0
        ? { ...canonical, columns: alternateHeaders }
        : canonical;
    }
    if (!Array.isArray(block.headers)) return block;
    const { headers, ...rest } = block;
    return { ...rest, columns: headers };
  });
}

export function sanitizeMissionArguments(toolName, value) {
  const fields = missionArgumentFields[toolName];
  if (!fields || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (JSON.stringify(value).length > 80000) return null;
  const selected = Object.fromEntries(fields.filter(key => Object.hasOwn(value,key)).map(key => [key, value[key]]));
  if (['word.create', 'hwp.create'].includes(toolName) && Object.hasOwn(selected, 'blocks')) {
    selected.blocks = canonicalizeDocumentTableHeaders(selected.blocks);
  }
  return Object.keys(selected).length ? JSON.parse(JSON.stringify(selected)) : null;
}
