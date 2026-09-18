import { environment } from './environment';

describe('environment', () => {
  it('dev-окружение содержит только флаг production=false', () => {
    expect(environment).toEqual({ production: false });
    expect(Object.keys(environment)).toEqual(['production']);
    expect(typeof environment.production).toBe('boolean');
  });
});
