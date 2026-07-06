export function processData(data) {
  if (!data) {
    throw new Error('Data is required');
  }
  // Process the data
  return data.toUpperCase();
}

export function formatDate(date) {
  // TODO: Add proper date formatting
  return date.toString();
}

export function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (error) {
    return null;
  }
}
