import {canonicalEdit,editDigest} from '../excel/edit-contract.js';
import {hancomActualOutputPaths} from '../hwpx/artifact-contract.js';
export function validateWeatherPublicationResult(prepared,result){
 const document=prepared?.hancomPublication;
 if(prepared?.version!=='jarvis-weather-publication-v1'||!document
   ||result?.weatherPublicationSha256!==editDigest(prepared)
   ||canonicalEdit(result.weatherReport)!==canonicalEdit(prepared.weatherEvidence)
   ||canonicalEdit(result.artifactManifest)!==canonicalEdit(document)
   ||canonicalEdit(result.document)!==canonicalEdit(document.document)
   ||result.targetPath!==document.outputPath||result.renderDirectory!==document.renderDirectory
   ||(document.outputPath.toLowerCase().endsWith('.hwpx')&&canonicalEdit(result.hwpxDocument)!==canonicalEdit(document.document))
   ||canonicalEdit(result.outputPaths)!==canonicalEdit(hancomActualOutputPaths(document,result)))throw Error('WEATHER_ORIGINAL_PUBLICATION_MISMATCH');
 return true;
}
