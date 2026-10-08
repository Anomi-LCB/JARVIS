// Decimal source values are added before conversion to the JSON number contract.
// Never silently round a result that that contract cannot preserve.
function invalid(code = 'WORKFLOW_NUMBER_INVALID') {
  const error = new Error(code); error.code = code; throw error;
}
function canonical(coefficient, scale) {
  if (coefficient === 0n) return {coefficient: 0n, scale: 0};
  while (coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  return {coefficient, scale};
}
function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') invalid();
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) invalid();
  const text = String(value).trim();
  if (text.length > 400) invalid();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) invalid();
  const exponent = Number(match[5] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 400) invalid();
  const fraction = match[3] ?? match[4] ?? '';
  const coefficient = BigInt(`${match[1] === '-' ? '-' : ''}${match[2] ?? '0'}${fraction}`);
  return canonical(coefficient, fraction.length - exponent);
}
export function sumDecimalValues(values) {
  const parts = values.map(decimal);
  const scale = parts.reduce((maximum, part) => Math.max(maximum, part.scale), 0);
  const total = canonical(parts.reduce((sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale), 0n), scale);
  const number = Number(`${total.coefficient}e${-total.scale}`);
  if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) invalid('WORKFLOW_SUM_UNREPRESENTABLE');
  const roundTrip = decimal(number);
  if (roundTrip.coefficient !== total.coefficient || roundTrip.scale !== total.scale) invalid('WORKFLOW_SUM_UNREPRESENTABLE');
  return Object.is(number, -0) ? 0 : number;
}
