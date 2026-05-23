// Shapes a user record into the API's response object. Just a passthrough that
// picks fields. NOT where the whitespace fix should go (we want normalization
// at the serialization boundary, not in field selection).
export const formatUser = (record) => ({
  id: record.id,
  name: record.name,
  email: record.email,
  age: record.age,
  active: record.active,
  preferences: record.preferences,
});
