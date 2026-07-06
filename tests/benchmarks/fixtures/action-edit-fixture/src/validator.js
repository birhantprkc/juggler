export function validateEmail(email) {
  // Simple email validation
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

export function validatePassword(password) {
  // Password must be at least 8 characters
  return password.length >= 8;
}

export function validateUsername(username) {
  // Username must be 3-20 alphanumeric characters
  const re = /^[a-zA-Z0-9]{3,20}$/;
  return re.test(username);
}
