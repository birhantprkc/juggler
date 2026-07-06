// TODO: Add error handling
function fetchData(url) {
  return fetch(url);
}

// TODO: Add retry logic
function postData(url, data) {
  return fetch(url, { method: 'POST', body: data });
}

function deleteResource(id) {
  // No TODO here
  return fetch(`/api/resource/${id}`, { method: 'DELETE' });
}
