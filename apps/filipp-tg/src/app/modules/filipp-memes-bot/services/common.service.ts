export class CommonService {
  public static getRandomValueFromArray<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }
}
