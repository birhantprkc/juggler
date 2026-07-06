// TODO: Implement proper authentication
function login(username, password) {
  // FIXME: This is insecure!
  return username === 'admin' && password === 'admin';
}

function logout() {
  // TODO: Clear session
  return true;
}

function checkAuth() {
  // TODO: Verify token
  return false;
}
