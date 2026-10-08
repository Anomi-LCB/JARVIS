import { summarizeSemgWaveform } from './semg-waveform.js';
const METRICS = Object.freeze({
  steps: { units: new Map([['step', 1], ['steps', 1], ['count', 1]]), canonicalUnit: 'steps' },
  heart_rate: { units: new Map([['bpm', 1], ['beats/min', 1]]), canonicalUnit: 'bpm' },
  sleep_duration: { units: new Map([['min', 1], ['minutes', 1], ['h', 60], ['hr', 60]]), canonicalUnit: 'minutes' },
  semg_rms: { units: new Map([['uv', 1], ['µv', 1], ['μv', 1], ['mv', 1000], ['v', 1_000_000]]), canonicalUnit: 'uV', optional: true },
  semg_raw: { units: new Map([['uv', 1], ['µv', 1], ['μv', 1], ['mv', 1000], ['v', 1_000_000]]), canonicalUnit: 'uV', optional: true }
});
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
  && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
const boundedText = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 120;
// Supplied RMS aggregates only: this does not process waveforms or infer calibration/gain.
function measurementMetadata(record, index) {
  if (!['semg_rms','semg_raw'].includes(record.metric)) {
    if (record.measurement !== undefined) throw new TypeError(`health-record-invalid:${index}`);
    return null;
  }
  const item = record.measurement ?? {};
  const keys = ['sampleRateHz','windowMs','electrodePlacement','processing','amplitudeReference'];
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !keys.includes(key))
    || ['sampleRateHz','windowMs'].some(key => item[key] != null && (!Number.isFinite(item[key]) || item[key] <= 0))
    || ['electrodePlacement','processing'].some(key => item[key] != null && !boundedText(item[key]))
    || (item.amplitudeReference != null && !['input_referred','device_output'].includes(item.amplitudeReference))) {
    throw new TypeError(`health-record-invalid:${index}`);
  }
  return Object.fromEntries(keys.map(key => [key, item[key] ?? null]));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function calibrationMetadata(record, observedAt, index) {
  const item = record.calibration;
  if (item === undefined) return null;
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).some(key => !['status','method','performedAt','reference'].includes(key))
    || !['unknown','calibrated','uncalibrated'].includes(item.status)
    || (record.calibrationStatus !== undefined && record.calibrationStatus !== item.status)
    || (item.method !== undefined && !boundedText(item.method))
    || (item.reference !== undefined && !boundedText(item.reference))
    || (item.performedAt !== undefined && (!validTime(item.performedAt) || Date.parse(item.performedAt) > Date.parse(observedAt)))
    || (item.status === 'calibrated' && !['method','performedAt','reference'].every(key => Object.hasOwn(item,key)))) {
    throw new TypeError(`health-record-invalid:${index}`);
  }
  return { ...item };
}
function dailySeries(samples, totalDays) {
  const groups = new Map();
  for (const sample of samples) {
    const origin = { source: sample.source, dataOrigin: sample.dataOrigin, sensorId: sample.sensorId,
      recordingMethod: sample.recordingMethod, calibrationStatus: sample.calibrationStatus, calibration: sample.calibration };
    if (sample.measurement) origin.measurement = sample.measurement;
    const key = canonical(origin);
    if (!groups.has(key)) groups.set(key, { ...origin, days: new Map() });
    const group = groups.get(key);
    let day = group.days.get(sample.date);
    if (!day) { day = { date: sample.date, count: 0, mean: 0, min: sample.value, max: sample.value }; group.days.set(sample.date,day); }
    day.count++; day.mean += (sample.value - day.mean) / day.count;
    day.min = Math.min(day.min,sample.value); day.max = Math.max(day.max,sample.value);
  }
  return [...groups.values()].map(({days,...origin}) => ({ ...origin,
    missingDayCount: totalDays - days.size, comparabilityVerified: false,
    daily: [...days.values()].map((day,index,array) => ({ ...day,
      daysSincePreviousObservation: index ? (Date.parse(day.date)-Date.parse(array[index-1].date))/86400_000 : null,
      changeFromPreviousRecordedMean: index ? day.mean-array[index-1].mean : null
    }))
  }));
}

/** Summarize an explicitly supplied, already-authorized record set. This performs no diagnosis. */
export function summarizeHealthRecords({ records = [], startDate, endDate, now = new Date().toISOString(), staleAfterMs = 7 * 86400_000 } = {}) {
  if (!Array.isArray(records) || records.length > 20_000) throw new TypeError('health-records-must-be-bounded-array');
  let waveformSamples = 0;
  for (const record of records) {
    if (record?.metric === 'semg_raw') {
      if (!Array.isArray(record.waveform?.packets)) throw new TypeError('health-record-invalid:waveform');
      if (record.waveform.packets.length > 1000) throw new TypeError('health-waveform-input-limit');
      for (const packet of record.waveform.packets) {
        if (!Array.isArray(packet?.values) || (waveformSamples += packet.values.length) > 100_000) throw new TypeError('health-waveform-input-limit');
      }
    } else if (record?.waveform !== undefined) throw new TypeError('health-waveform-metric-required');
  }
  if (!validDate(startDate) || !validDate(endDate)
    || startDate > endDate || !validTime(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError('health-summary-range-or-clock-invalid');
  }
  if ((Date.parse(endDate) - Date.parse(startDate)) / 86400_000 > 3660) throw new TypeError('health-summary-range-or-clock-invalid');
  const supplied = records.map((record, index) => {
    const metric = Object.hasOwn(METRICS, record?.metric) ? METRICS[record.metric] : undefined;
    const factor = metric?.units.get(String(record?.unit ?? '').trim().toLowerCase());
    const observedAt = record?.observedAt ?? record?.startTime;
    if (!metric || (record.metric !== 'semg_raw' && (!Number.isFinite(record?.value) || record.value < 0 || !Number.isFinite(record.value * factor))) || !factor || !validTime(observedAt)
      || Date.parse(observedAt) > Date.parse(now)
      || (record.sensorId !== undefined && (typeof record.sensorId !== 'string' || !record.sensorId.trim() || record.sensorId.length > 120))
      || (record.calibrationStatus !== undefined && !['unknown','calibrated','uncalibrated'].includes(record.calibrationStatus))
      || (record.recordingMethod !== undefined && ![0,1,2,3].includes(record.recordingMethod))
      || (record.dataOrigin !== undefined && !boundedText(record.dataOrigin))
      || (record.recordId !== undefined && !boundedText(record.recordId))
      || typeof record?.source !== 'string' || !record.source.trim() || record.source.length > 120) {
      throw new TypeError(`health-record-invalid:${index}`);
    }
    const calibration = calibrationMetadata(record, observedAt, index);
    const measurement = measurementMetadata(record, index);
    const raw = record.metric === 'semg_raw' ? summarizeSemgWaveform(record,{factor,observedAt,now,index}) : null;
    const date = new Date(observedAt).toISOString().slice(0, 10);
    if (date < startDate || date > endDate) return null;
    return { metric: record.metric, value: raw ? raw.value : record.value * factor, unit: metric.canonicalUnit,
      originalValue: raw ? null : record.value, originalUnit: record.unit, observedAt: new Date(observedAt).toISOString(),
      originalObservedAt: observedAt, sensorId: record.sensorId?.trim() ?? null,
      calibrationStatus: calibration?.status ?? record.calibrationStatus ?? 'unknown',
      calibration, calibrationVerified: false, calibrationApplied: false,
      ...(measurement ? { measurement, measurementConditionsVerified: false, rawSignalProcessed: Boolean(raw) } : {}),
      ...(raw ? { waveform: raw.waveform, valueMeaning: 'received-samples-rms' } : {}),
      recordingMethod: record.recordingMethod ?? 0, dataOrigin: record.dataOrigin ?? null,
      recordId: record.recordId ?? null,
      source: record.source.trim(), date };
  }).filter(Boolean);
  const identities = new Map();
  let duplicateRecordCount = 0;
  const normalized = supplied.filter(sample => {
    if (sample.recordId === null) return true;
    const key = JSON.stringify([sample.dataOrigin === null ? 'source' : 'data-origin', sample.dataOrigin ?? sample.source, sample.recordId]);
    const fingerprint = canonical(sample);
    if (identities.has(key)) {
      if (identities.get(key) !== fingerprint) throw new TypeError('health-record-identity-conflict');
      duplicateRecordCount++;
      return false;
    }
    identities.set(key, fingerprint);
    return true;
  }).sort((a,b) => a.observedAt.localeCompare(b.observedAt));
  const expectedDates = [];
  for (let day = Date.parse(`${startDate}T00:00:00.000Z`), last = Date.parse(`${endDate}T00:00:00.000Z`); day <= last; day += 86400_000) {
    expectedDates.push(new Date(day).toISOString().slice(0, 10));
  }
  const metrics = Object.fromEntries(Object.keys(METRICS).filter(metric => !METRICS[metric].optional || normalized.some(sample => sample.metric === metric)).map(metric => {
    const samples = normalized.filter(item => item.metric === metric);
    const observedDates = new Set(samples.map(item => item.date));
    const latest = samples.at(-1) ?? null;
    return [metric, { count: samples.length, unit: METRICS[metric].canonicalUnit,
      sourceSeries: dailySeries(samples, expectedDates.length),
      missingDates: expectedDates.filter(date => !observedDates.has(date)), latestObservedAt: latest?.observedAt ?? null,
      stale: Boolean(latest && Date.parse(now) - Date.parse(latest.observedAt) > staleAfterMs),
      samples: samples.map(({ metric: _metric, date: _date, ...sample }) => sample) }];
  }));
  return { schemaVersion: 'jarvis-health-record-summary-v1', range: { startDate, endDate }, generatedAt: new Date(now).toISOString(),
    recordCount: normalized.length, duplicateRecordCount,
    unidentifiedRecordCount: normalized.filter(sample => sample.recordId === null).length,
    metrics, medicalInterpretation: 'none', diagnosisProvided: false,
    limitations: ['제공된 기록만 집계했으며 누락·지연은 기록 범위의 한계일 수 있습니다.', '의료 진단이나 치료 권고를 제공하지 않습니다.'] };
}

const markdownCell = value => String(value ?? '미확인').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replace(/[\r\n]/gu,' ');
export function buildHealthRecordReport(input) {
  const summary = summarizeHealthRecords(input);
  const lines = ['# 제공된 건강 기록 요약','',`기간: ${summary.range.startDate} ~ ${summary.range.endDate} (UTC 날짜)`,
    `작성 시각: ${summary.generatedAt}`,`기록 ${summary.recordCount}건 · 확인된 중복 ${summary.duplicateRecordCount}건 · ID 없는 기록 ${summary.unidentifiedRecordCount}건`,
    '', '제공된 자료의 통계입니다. 기기·보정·측정의 비교 가능성은 검증하지 않았습니다. 의료 진단·치료 권고가 아닙니다.',
    '날짜별 평균은 입력 표본의 평균이며 하루 전체의 건강 상태나 걸음 총합을 뜻하지 않습니다. 결측은 0으로 채우지 않습니다.',''];
  for (const [metric,data] of Object.entries(summary.metrics)) {
    lines.push(`## ${metric} (${data.unit})`, `자료 없는 UTC 날짜: ${data.missingDates.join(', ') || '없음'}`, '');
    if (metric === 'semg_rms') lines.push('제공된 RMS 집계값입니다. 원시 파형 처리·근력·피로·질환 판단을 수행하지 않습니다. 측정 조건이 달라지면 별도 시계열로 표시합니다.', '');
    if (metric === 'semg_raw') {
      lines.push('원시 전압 표본에서 계산한 수신 표본 RMS입니다. 누락 구간은 보간하거나 0으로 채우지 않습니다. 필터·보정·근력·피로·질환 판단은 적용하지 않습니다. 날짜별 표는 기록별 RMS의 산술 통계이며 하루 전체 파형의 RMS가 아닙니다.', '');
      for (const sample of data.samples) {
        const wave=sample.waveform;
        lines.push(`파형: ${markdownCell(sample.recordId)} · 시각: ${sample.observedAt} · 수신 ${wave.receivedSampleCount}/${wave.expectedSampleCount} 표본 · 결측 ${wave.missingSampleCount} 표본 · 수신률 ${wave.coverage} · 누락 패킷 ${wave.missingPacketSequences.join(', ') || '없음'}`,
          `결측 표본 구간(시작 포함·끝 제외): ${markdownCell(JSON.stringify(wave.missingSampleRanges))}`, '');
      }
    }
    for (const series of data.sourceSeries) {
      if (series.measurement) lines.push(`sEMG 측정 조건(제공값, 미검증): ${markdownCell(JSON.stringify(series.measurement))}`, '');
      lines.push(`출처: ${markdownCell(series.source)} · 앱: ${markdownCell(series.dataOrigin)} · 센서: ${markdownCell(series.sensorId)} · 기록 방식: ${series.recordingMethod}`,
        `보정 상태(제공값): ${markdownCell(series.calibrationStatus)} · 보정 조건: ${markdownCell(JSON.stringify(series.calibration))} · 해당 출처 결측 ${series.missingDayCount}일`,
        '', '| UTC 날짜 | 표본 수 | 평균 | 최솟값 | 최댓값 | 이전 기록과 간격(일) | 이전 기록 평균과 차이 |',
        '| --- | --- | --- | --- | --- | --- | --- |');
      for (const day of series.daily) lines.push(`| ${day.date} | ${day.count} | ${day.mean} | ${day.min} | ${day.max} | ${day.daysSincePreviousObservation ?? '없음'} | ${day.changeFromPreviousRecordedMean ?? '없음'} |`);
      lines.push('');
    }
  }
  return {summary, reportMarkdown: lines.join('\n')+'\n'};
}
