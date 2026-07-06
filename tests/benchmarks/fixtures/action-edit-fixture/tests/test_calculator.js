import { add, subtract, multiply, divide } from '../src/calculator.js';

function testAdd() {
  const result = add(2, 3);
  if (result !== 5) {
    console.error('FAIL: add(2, 3) expected 5, got', result);
    process.exit(1);
  }
  console.log('PASS: add');
}

function testSubtract() {
  const result = subtract(5, 3);
  if (result !== 2) {
    console.error('FAIL: subtract(5, 3) expected 2, got', result);
    process.exit(1);
  }
  console.log('PASS: subtract');
}

function testMultiply() {
  const result = multiply(4, 5);
  if (result !== 20) {
    console.error('FAIL: multiply(4, 5) expected 20, got', result);
    process.exit(1);
  }
  console.log('PASS: multiply');
}

function testDivide() {
  const result = divide(10, 2);
  if (result !== 5) {
    console.error('FAIL: divide(10, 2) expected 5, got', result);
    process.exit(1);
  }
  console.log('PASS: divide');
}

testAdd();
testSubtract();
testMultiply();
testDivide();
console.log('All tests passed!');
