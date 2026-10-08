export function screenViewDimensions(rawWidth, rawHeight, orientation = 'hud-landscape') {
  const width = positiveInteger(rawWidth, 480);
  const height = positiveInteger(rawHeight, 640);
  if (orientation === 'portrait') return { width, height };
  return { width: Math.round(width * 4 / 3), height: width };
}

export function mapViewPointToDevice({ normalizedX, normalizedY, rawWidth, rawHeight, orientation = 'hud-landscape' }) {
  const width = positiveInteger(rawWidth, 480);
  const height = positiveInteger(rawHeight, 640);
  const nx = clamp(Number(normalizedX), 0, 1);
  const ny = clamp(Number(normalizedY), 0, 1);
  if (orientation === 'hud-landscape') {
    const cropHeight = Math.min(height, Math.round(width * 3 / 4));
    const cropTop = Math.floor((height - cropHeight) / 2);
    return {
      x: Math.round(nx * (width - 1)),
      y: cropTop + Math.round(ny * (cropHeight - 1))
    };
  }
  return {
    x: Math.round(nx * (width - 1)),
    y: Math.round(ny * (height - 1))
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
