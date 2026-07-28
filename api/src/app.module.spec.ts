import { join } from 'path';
import { graphqlSchemaDestination } from './app.module';

describe('GraphQL schema destination', () => {
  it('keeps both generated schemas in memory in production', () => {
    expect(graphqlSchemaDestination('schema.gql', 'production')).toBe(true);
    expect(graphqlSchemaDestination('admin-schema.gql', 'production')).toBe(
      true,
    );
  });

  it('writes generated schemas into src outside production', () => {
    expect(graphqlSchemaDestination('schema.gql', 'development')).toBe(
      join(process.cwd(), 'src/schema.gql'),
    );
    expect(graphqlSchemaDestination('admin-schema.gql', 'test')).toBe(
      join(process.cwd(), 'src/admin-schema.gql'),
    );
  });
});
