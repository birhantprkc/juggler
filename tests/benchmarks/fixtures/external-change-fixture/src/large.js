// Large file for performance testing (10KB)
export const CONFIG = {
  setting1: 'value1',
  setting2: 'value2',
  setting3: 'value3',
  setting4: 'value4',
  setting5: 'value5',
};

export const DATA = Array(500).fill(0).map((_, i) => ({
  id: i,
  name: `Item ${i}`,
  description: `This is item number ${i} with some additional text to make the file larger`,
  metadata: {
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    tags: ['tag1', 'tag2', 'tag3'],
    status: 'active'
  }
}));

export const CONSTANTS = {
  MAX_RETRIES: 3,
  TIMEOUT: 5000,
  API_VERSION: 'v1',
  DEFAULT_PAGE_SIZE: 50,
};
