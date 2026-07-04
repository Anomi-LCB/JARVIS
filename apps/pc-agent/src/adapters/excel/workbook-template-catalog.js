import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const builtinTemplates = Object.freeze({
  blank: { name: 'Blank workbook', defaultStyle: { headerBold: false, headerFill: null, autoFilter: false } },
  table: { name: 'Table workbook', defaultStyle: { headerBold: true, headerFill: 'FFD9EAD3', autoFilter: true } },
  report: { name: 'Report workbook', defaultStyle: { headerBold: true, headerFill: 'FFB6D7A8', autoFilter: true } }
});

export const currentWorkbookTemplateSchemaVersion = 'b-workbook-template-v2';

export class WorkbookTemplateCatalog {
  constructor({ builtin = builtinTemplates, allowedTemplateRoots = ['apps/pc-agent/templates/excel'] } = {}) {
    this.builtin = builtin;
    this.allowedTemplateRoots = allowedTemplateRoots.map((root) => resolve(root));
  }

  async resolveTemplate(template = {}) {
    const templateFile = template.templateFile ?? template.path ?? null;
    const fileTemplate = templateFile ? await this.loadTemplateFile(templateFile) : {};
    const templateId = String(fileTemplate.templateId ?? template.templateId ?? template.id ?? 'blank').trim() || 'blank';
    const preset = this.builtin[templateId] ?? this.builtin.blank;
    const inlineMigration = templateFile ? null : migrateWorkbookTemplateManifest({ ...template, templateId }, { source: 'inline-template' });
    return {
      schemaVersion: fileTemplate.schemaVersion ?? inlineMigration?.manifest?.schemaVersion ?? currentWorkbookTemplateSchemaVersion,
      templateId,
      name: fileTemplate.name ?? template.name ?? preset.name,
      source: templateFile ? 'file' : 'builtin',
      templateFile: templateFile ? resolve(templateFile) : null,
      version: fileTemplate.version ?? template.version ?? '1.0.0',
      migration: fileTemplate.migration ?? inlineMigration,
      defaultStyle: {
        ...preset.defaultStyle,
        ...(fileTemplate.defaultStyle ?? {}),
        ...(template.defaultStyle ?? {})
      },
      defaultCharts: [...(fileTemplate.defaultCharts ?? []), ...(template.defaultCharts ?? [])],
      visualExpectations: {
        requireHeaderStyle: Boolean(fileTemplate.visualExpectations?.requireHeaderStyle ?? template.visualExpectations?.requireHeaderStyle ?? false),
        requireAutoFilter: Boolean(fileTemplate.visualExpectations?.requireAutoFilter ?? template.visualExpectations?.requireAutoFilter ?? false),
        requireChartDrawing: Boolean(fileTemplate.visualExpectations?.requireChartDrawing ?? template.visualExpectations?.requireChartDrawing ?? false)
      }
    };
  }

  async loadTemplateFile(path) {
    const resolved = resolve(path);
    if (!this.allowedTemplateRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`template-outside-allowed-roots:${resolved}`);
    }
    const text = await readFile(resolved, 'utf8');
    const parsed = JSON.parse(text);
    const migrated = migrateWorkbookTemplateManifest(parsed, { source: resolved });
    if (!migrated.manifest.templateId) {
      throw new Error(`template-id-required:${resolved}`);
    }
    return {
      ...migrated.manifest,
      migration: migrated
    };
  }
}

export function migrateWorkbookTemplateManifest(manifest = {}, { source = 'inline-template' } = {}) {
  const input = manifest && typeof manifest === 'object' ? manifest : {};
  const fromSchemaVersion = input.schemaVersion ?? input.templateSchemaVersion ?? (input.templateId ? 'b-workbook-template-v1' : 'legacy-v0');
  const steps = [];
  const migrated = { ...input };
  if (!migrated.templateId && migrated.id) {
    migrated.templateId = migrated.id;
    steps.push('id-to-templateId');
  }
  if (!migrated.defaultStyle && migrated.style) {
    migrated.defaultStyle = migrated.style;
    steps.push('style-to-defaultStyle');
  }
  if (!migrated.defaultCharts && migrated.charts) {
    migrated.defaultCharts = migrated.charts;
    steps.push('charts-to-defaultCharts');
  }
  if (!migrated.visualExpectations && (migrated.visual || migrated.expectations)) {
    const visual = migrated.visual ?? migrated.expectations;
    migrated.visualExpectations = {
      requireHeaderStyle: Boolean(visual.requireHeaderStyle ?? visual.headerStyle),
      requireAutoFilter: Boolean(visual.requireAutoFilter ?? visual.autoFilter),
      requireChartDrawing: Boolean(visual.requireChartDrawing ?? visual.chartDrawing)
    };
    steps.push('visual-to-visualExpectations');
  }
  migrated.schemaVersion = currentWorkbookTemplateSchemaVersion;
  migrated.defaultStyle = migrated.defaultStyle ?? {};
  migrated.defaultCharts = Array.isArray(migrated.defaultCharts) ? migrated.defaultCharts : [];
  migrated.visualExpectations = {
    requireHeaderStyle: Boolean(migrated.visualExpectations?.requireHeaderStyle),
    requireAutoFilter: Boolean(migrated.visualExpectations?.requireAutoFilter),
    requireChartDrawing: Boolean(migrated.visualExpectations?.requireChartDrawing)
  };
  return {
    migrationVersion: 'b-workbook-template-migration-v1',
    status: migrated.templateId ? 'passed' : 'failed',
    source,
    fromSchemaVersion,
    toSchemaVersion: currentWorkbookTemplateSchemaVersion,
    migrated: steps.length > 0 || fromSchemaVersion !== currentWorkbookTemplateSchemaVersion,
    steps,
    manifest: migrated,
    failures: migrated.templateId ? [] : ['template-id-required']
  };
}

export function createWorkbookTemplateMigrationReport({ fixtures = [] } = {}) {
  const items = fixtures.map((fixture) => {
    const migration = migrateWorkbookTemplateManifest(fixture.manifest ?? {}, { source: fixture.fixtureId ?? 'fixture' });
    const expectedTemplateId = fixture.expected?.templateId ?? migration.manifest.templateId;
    const expectedSchemaVersion = fixture.expected?.schemaVersion ?? currentWorkbookTemplateSchemaVersion;
    const failures = [
      ...migration.failures,
      ...(migration.manifest.templateId === expectedTemplateId ? [] : [`templateId:${migration.manifest.templateId}`]),
      ...(migration.manifest.schemaVersion === expectedSchemaVersion ? [] : [`schemaVersion:${migration.manifest.schemaVersion}`])
    ];
    return {
      itemVersion: 'b-workbook-template-migration-item-v1',
      fixtureId: fixture.fixtureId,
      title: fixture.title,
      status: failures.length ? 'failed' : 'passed',
      fromSchemaVersion: migration.fromSchemaVersion,
      toSchemaVersion: migration.toSchemaVersion,
      migrated: migration.migrated,
      steps: migration.steps,
      templateId: migration.manifest.templateId,
      failures
    };
  });
  const failed = items.filter((item) => item.status === 'failed');
  return {
    reportVersion: 'b-workbook-template-migration-report-v1',
    status: failed.length ? 'failed' : 'passed',
    fixtureCount: fixtures.length,
    migratedCount: items.filter((item) => item.migrated).length,
    currentSchemaVersion: currentWorkbookTemplateSchemaVersion,
    items,
    failures: failed
  };
}

function isInside(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}
