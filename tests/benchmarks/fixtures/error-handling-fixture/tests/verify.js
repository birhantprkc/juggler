import { processData, formatDate, parseJSON } from '../src/utils.js';

function verify() {
  // Verify the edits were made correctly
  const data = processData('hello');
  if (data !== 'HELLO') {
    console.error('FAIL: processData');
    process.exit(1);
  }

  console.log('PASS: All verifications successful');
  process.exit(0);
}

verify();
