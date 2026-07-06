export function Button({ label, onClick }) {
  return `<button onclick="${onClick}">${label}</button>`;
}
