import { join } from 'node:path';

export const HANCOM_MAX_RENDER_PAGES = 50;

export function hancomPublicationPaths(outputPath, renderDirectory, pageCount = HANCOM_MAX_RENDER_PAGES) {
  if (renderDirectory === null) return [outputPath];
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > HANCOM_MAX_RENDER_PAGES) throw Error('HANCOM_PAGE_COUNT_INVALID');
  return [outputPath, join(renderDirectory, 'manifest.json'), join(renderDirectory, 'document.pdf'),
    ...Array.from({ length: pageCount }, (_, i) => join(renderDirectory, `page-${i + 1}.png`)), join(renderDirectory, 'structure.hwpx')];
}

// Reservations include all bounded pages; only the observed page count may be
// used as output evidence. A reservation is never proof that a file exists.
export function hancomActualOutputPaths(prepared, result) {
  if (prepared?.manifestVersion !== 'jarvis-hancom-publication-v1'
    || prepared.maxRenderPages !== HANCOM_MAX_RENDER_PAGES
    || prepared.verifyRendering !== (prepared.renderDirectory !== null)
    || JSON.stringify(prepared.paths) !== JSON.stringify(hancomPublicationPaths(prepared.outputPath, prepared.renderDirectory))) {
    throw Error('HANCOM_MANIFEST_INVALID');
  }
  if (!prepared.verifyRendering) return [prepared.outputPath];
  if (result.nativeRendering?.status !== 'passed' || result.nativeRendering.actualRenderingExecuted !== true
    || result.nativeRendering.outputDirectory !== prepared.renderDirectory
    || result.nativeRendering.manifestPath !== join(prepared.renderDirectory, 'manifest.json')) throw Error('HANCOM_RENDER_CONTRACT_INVALID');
  return hancomPublicationPaths(prepared.outputPath, prepared.renderDirectory, result.nativeRendering.pageCount);
}
