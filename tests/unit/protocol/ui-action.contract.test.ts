import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  parseUiAction,
  uiActionKinds,
  uiActionPayloadSchemas,
  uiActionStatuses,
  type UiActionKind,
} from '../../../src/protocol/ui-action';

const fixtures = join(__dirname, '../../contract-fixtures/ui-action-v1');
const golden = JSON.parse(readFileSync(join(fixtures, 'schema.json'), 'utf8')) as {
  properties: { kind: { enum: string[] }; status: { enum: string[] } };
  $defs: Record<string, { properties: Record<string, unknown>; required?: string[] }>;
};

function objectKeys(schema: z.ZodType): string[] {
  // Unwrap refinements (ZodPipe/effects) down to the strict object shape.
  let current = schema as unknown as { shape?: Record<string, unknown>; def?: { in?: unknown; schema?: unknown } };
  while (!current.shape && (current.def?.in || current.def?.schema)) {
    current = (current.def.in ?? current.def.schema) as typeof current;
  }
  return Object.keys(current.shape ?? {}).sort();
}

describe('dewee.ui-action.v1 contract', () => {
  it('knows exactly the kinds and statuses of the golden schema', () => {
    expect([...uiActionKinds].sort()).toEqual([...golden.properties.kind.enum].sort());
    expect([...uiActionStatuses].sort()).toEqual([...golden.properties.status.enum].sort());
  });

  it.each(uiActionKinds)('payload fields of %s match the golden schema', (kind: UiActionKind) => {
    const def = golden.$defs[`payload.${kind}`];
    expect(def, `golden schema has payload.${kind}`).toBeDefined();
    expect(objectKeys(uiActionPayloadSchemas[kind])).toEqual(Object.keys(def!.properties).sort());
  });

  it.each(readdirSync(join(fixtures, 'examples')))('accepts the Go example %s', (file) => {
    const example = JSON.parse(readFileSync(join(fixtures, 'examples', file), 'utf8'));
    expect(parseUiAction(example)).not.toBeNull();
  });
});
