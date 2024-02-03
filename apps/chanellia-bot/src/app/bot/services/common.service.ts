import { User } from 'grammy/out/types';

export class CommonService {
  public static usernameFromTgUser(user: User): string {
    const userMeta = [];

    if (user.username) {
      userMeta.push(`@${user.username}`);
    } else {
      userMeta.push(user.first_name, user.last_name);
    }

    if (user.language_code !== 'ru') {
      userMeta.push(`(${user.language_code})`);
    }

    return userMeta.filter(Boolean).join(' ');
  }
}
