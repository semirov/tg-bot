import { environment } from './environment.prod';

describe('environment.prod', () => {
  it('prod-окружение содержит только флаг production=true', () => {
    expect(environment).toEqual({ production: true });
    expect(Object.keys(environment)).toEqual(['production']);
    expect(typeof environment.production).toBe('boolean');
  });
});
