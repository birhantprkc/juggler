import { login, logout } from '../src/auth.js';

// TODO: Add more test cases
function testLogin() {
  console.log(login('admin', 'admin') === true);
}

function testLogout() {
  console.log(logout() === true);
}

testLogin();
testLogout();
