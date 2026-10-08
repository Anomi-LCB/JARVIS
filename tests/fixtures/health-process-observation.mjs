import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function observeHealthProcessRecovery() {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-health-process-'));
    const base = { metric: 'heart_rate', unit: 'bpm', source: 'synthetic-watch', sensorId: 'sensor-a', dataOrigin: 'fixture.app', recordingMethod: 2 };
    const records = [
        { ...base, recordId: 'a', value: 70, observedAt: '2026-02-20T12:00:00Z' },
        { ...base, recordId: 'b', value: 90, observedAt: '2026-02-20T13:00:00Z' },
        { ...base, recordId: 'c', value: 60, observedAt: '2026-02-22T12:00:00Z' },
        { ...base, recordId: 'd', sensorId: 'sensor-b', value: 100, observedAt: '2026-02-20T12:00:00Z' }
    ];
    const source = JSON.stringify({ records });
    let active;
    const invoke = async (mode, missionId) => {
        const child = fork(new URL('./health-report-process.mjs', import.meta.url), [root, mode, ...(missionId ? [missionId] : [])], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        active = child;
        let stderr = '';
        child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes.toString(); });
        const exit = once(child, 'exit');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
        try {
            const response = await Promise.race([
                once(child, 'message').then(([message]) => message),
                exit.then(([code]) => { throw new Error(`Health process ended before observation: ${code} ${stderr.slice(-1000)}`); })
            ]);
            assert.equal(response.error, undefined, JSON.stringify(response));
            if (mode === 'generate') child.kill('SIGKILL');
            const [code, signal] = await exit;
            if (mode !== 'generate') assert.equal(code, 0, stderr);
            active = null;
            return { ...response, exitCode: code, exitSignal: signal, forciblyTerminated: mode === 'generate' };
        } finally { clearTimeout(timeout); }
    };
    try {
        await writeFile(join(root, 'records.json'), source);
        const generation = await invoke('generate');
        assert.equal(generation.status, 'COMPLETED');
        assert.equal(generation.preview.status, 'verified');
        const report = await readFile(join(root, 'report.md'), 'utf8');
        // Oracle is fixed independently of the shared summarizer/verifier implementation.
        assert.ok(report.includes('| 2026-02-20 | 2 | 80 | 70 | 90 | 없음 | 없음 |'));
        assert.ok(report.includes('| 2026-02-22 | 1 | 60 | 60 | 60 | 2 | -20 |'));
        assert.ok(report.includes('| 2026-02-20 | 1 | 100 | 100 | 100 | 없음 | 없음 |'));
        assert.ok(report.includes('자료 없는 UTC 날짜: 2026-02-21, 2026-02-23'));
        assert.ok(report.includes('의료 진단·치료 권고가 아닙니다.'));
        assert.ok(report.includes('결측은 0으로 채우지 않습니다.'));
        const missionBefore = await readFile(join(root, 'missions.json'));
        const restored = await invoke('preview', generation.missionId);
        assert.notEqual(generation.pid, restored.pid);
        assert.equal(restored.preview.status, 'verified');
        assert.equal(restored.preview.reportMarkdown, report);
        assert.equal(restored.preview.clinicalInterpretationVerified, false);
        assert.equal(restored.preview.deviceConnectionVerified, false);
        assert.deepEqual(await readFile(join(root, 'missions.json')), missionBefore);
        assert.equal(await readFile(join(root, 'records.json'), 'utf8'), source);
        await writeFile(join(root, 'records.json'), JSON.stringify({ records: records.map((r, i) => i ? r : { ...r, value: 75 }) }));
        const changedSource = await invoke('preview', generation.missionId);
        assert.equal(changedSource.preview.status, 'changed-or-unavailable');
        assert.equal(changedSource.preview.reportMarkdown, undefined);
        await writeFile(join(root, 'records.json'), source);
        await writeFile(join(root, 'report.md'), report.replace('| 80 |', '| 999 |'));
        const changedReport = await invoke('preview', generation.missionId);
        assert.equal(changedReport.preview.status, 'changed-or-unavailable');
        assert.equal(changedReport.preview.reportMarkdown, undefined);
        await rm(join(root, 'report.md'));
        const deletedReport = await invoke('preview', generation.missionId);
        assert.equal(deletedReport.preview.status, 'changed-or-unavailable');
        assert.equal(deletedReport.preview.reportMarkdown, undefined);
        assert.deepEqual(await readFile(join(root, 'missions.json')), missionBefore);
        const medicalRequest = await invoke('medical-request');
        assert.notEqual(medicalRequest.status, 'COMPLETED');
        assert.equal(medicalRequest.preview.reportMarkdown, undefined);
        await assert.rejects(readFile(join(root, 'report.md')), { code: 'ENOENT' });
        return { observedAt: new Date().toISOString(), platform: process.platform, syntheticRecords: true,
            actualIndependentProcesses: true, processIds: [generation, restored, changedSource, changedReport, deletedReport, medicalRequest].map(item => item.pid),
            generation: { status: generation.status, forciblyTerminated: generation.forciblyTerminated, exitCode: generation.exitCode, exitSignal: generation.exitSignal },
            restoration: { status: restored.preview.status, reportSha256: hash(report), missionStoreSha256: hash(missionBefore), missionStoreUnchanged: true },
            oracle: { separateSensors: true, sampleMean: 80, subsequentMean: 60, gapDays: 2, difference: -20, missingDates: ['2026-02-21', '2026-02-23'], notDiagnosisOrTreatment: true },
            changedSource: changedSource.preview.status, changedReport: changedReport.preview.status, deletedReport: deletedReport.preview.status,
            medicalRequest: { status: medicalRequest.status, noReportProduced: true },
            deviceConnectionVerified: false, clinicalInterpretationVerified: false, reportMarkdown: report };
    } finally {
        if (active && active.exitCode === null && active.signalCode === null) { const exit = once(active, 'exit'); active.kill('SIGKILL'); await exit; }
        await rm(root, { recursive: true, force: true });
    }
}
