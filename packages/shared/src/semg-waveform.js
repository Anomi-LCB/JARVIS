// Local import contract, not a device protocol or a clinical signal processor.
export function summarizeSemgWaveform(record, { factor, observedAt, now, index }) {
  const invalid = () => { throw new TypeError(`health-record-invalid:${index}`); };
  const wave = record.waveform;
  const rate = record.measurement?.sampleRateHz;
  if (record.value !== undefined || !Number.isFinite(rate) || rate <= 0 || rate > 100_000
    || !wave || typeof wave !== 'object' || Array.isArray(wave)
    || Object.keys(wave).some(key => !['firstSequence','expectedPacketCount','expectedSampleCount','packets'].includes(key))
    || !Number.isSafeInteger(wave.firstSequence) || wave.firstSequence < 0
    || !Number.isSafeInteger(wave.expectedPacketCount) || wave.expectedPacketCount < 1 || wave.expectedPacketCount > 1000
    || !Number.isSafeInteger(wave.firstSequence + wave.expectedPacketCount)
    || !Number.isSafeInteger(wave.expectedSampleCount) || wave.expectedSampleCount < 1 || wave.expectedSampleCount > 100_000
    || wave.expectedSampleCount / rate > 60
    || !Array.isArray(wave.packets) || !wave.packets.length || wave.packets.length > wave.expectedPacketCount
    || Date.parse(observedAt) + (wave.expectedSampleCount - 1) * 1000 / rate > Date.parse(now)) invalid();
  const packets = [], missingSampleRanges = [], sequences = new Set();
  let end = 0, lastSequence = wave.firstSequence - 1, received = 0, scale = 0, squares = 0;
  for (const packet of wave.packets) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || Object.keys(packet).some(key => !['sequence','startSample','values'].includes(key))
      || !Number.isSafeInteger(packet.sequence) || packet.sequence <= lastSequence
      || packet.sequence < wave.firstSequence || packet.sequence >= wave.firstSequence + wave.expectedPacketCount
      || !Number.isSafeInteger(packet.startSample) || packet.startSample < end
      || !Array.isArray(packet.values) || !packet.values.length
      || packet.startSample + packet.values.length > wave.expectedSampleCount) invalid();
    if (packet.startSample > end) missingSampleRanges.push({ startSample: end, endSampleExclusive: packet.startSample });
    const values = Array.from(packet.values, value => {
      if (!Number.isFinite(value) || !Number.isFinite(value * factor)) invalid();
      const converted = value * factor, absolute = Math.abs(converted);
      // Scaled sum of squares avoids overflowing intermediate v*v.
      if (absolute > scale) { squares = 1 + squares * (scale / absolute) ** 2; scale = absolute; }
      else if (scale) squares += (absolute / scale) ** 2;
      received++;
      return converted;
    });
    packets.push({ sequence: packet.sequence, startSample: packet.startSample, originalValues: [...packet.values], values });
    sequences.add(packet.sequence); lastSequence = packet.sequence; end = packet.startSample + values.length;
  }
  if (end < wave.expectedSampleCount) missingSampleRanges.push({ startSample: end, endSampleExclusive: wave.expectedSampleCount });
  const missingPacketSequences = [];
  for (let sequence = wave.firstSequence; sequence < wave.firstSequence + wave.expectedPacketCount; sequence++) {
    if (!sequences.has(sequence)) missingPacketSequences.push(sequence);
  }
  const rms = scale * Math.sqrt(squares / received);
  if (!Number.isFinite(rms)) invalid();
  return { value: rms, waveform: { ...wave, packets, sampleRateHz: rate, unit: 'uV', originalUnit: record.unit,
    receivedSampleCount: received, missingSampleCount: wave.expectedSampleCount - received,
    missingSampleRanges, missingPacketSequences, coverage: received / wave.expectedSampleCount,
    receivedSamplesRms: rms, interpolationApplied: false, filteringApplied: false, calibrationApplied: false,
    deviceConnectionVerified: false } };
}
