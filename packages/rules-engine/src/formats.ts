/**
 * Table formats supported by the engine. These mirror the formats the live
 * Grimore app exposes when creating a table ("pod", "edh", "modern").
 */
export type FormatId = 'pod' | 'edh' | 'modern';

export interface FormatDefinition {
  readonly id: FormatId;
  readonly label: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultPlayers: number;
  readonly startingLife: number;
  /** Whether the 21-commander-damage elimination rule applies. */
  readonly commanderDamageRule: boolean;
  /** Whether the 10-poison elimination rule applies (true for every format). */
  readonly poisonRule: boolean;
}

export const FORMATS: Readonly<Record<FormatId, FormatDefinition>> = Object.freeze({
  pod: Object.freeze({
    id: 'pod',
    label: 'Commander Pod',
    minPlayers: 2,
    maxPlayers: 4,
    defaultPlayers: 4,
    startingLife: 40,
    commanderDamageRule: true,
    poisonRule: true,
  }),
  edh: Object.freeze({
    id: 'edh',
    label: '1v1 Commander',
    minPlayers: 2,
    maxPlayers: 2,
    defaultPlayers: 2,
    startingLife: 40,
    commanderDamageRule: true,
    poisonRule: true,
  }),
  modern: Object.freeze({
    id: 'modern',
    label: '1v1 Modern / Standard',
    minPlayers: 2,
    maxPlayers: 2,
    defaultPlayers: 2,
    startingLife: 20,
    commanderDamageRule: false,
    poisonRule: true,
  }),
});

export const FORMAT_IDS: readonly FormatId[] = Object.freeze(['pod', 'edh', 'modern']);

export function isFormatId(value: unknown): value is FormatId {
  return typeof value === 'string' && (FORMAT_IDS as readonly string[]).includes(value);
}

export function getFormat(id: FormatId): FormatDefinition {
  return FORMATS[id];
}

/** Rule thresholds shared by every format. */
export const POISON_THRESHOLD = 10;
export const COMMANDER_DAMAGE_THRESHOLD = 21;
