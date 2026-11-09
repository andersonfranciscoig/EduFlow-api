import bcrypt from "bcryptjs";
import type { PasswordHasher } from "../application/ports";

export class BcryptPasswordHasher implements PasswordHasher {
  constructor(private readonly cost = 12) {}

  hash(plain: string) {
    return bcrypt.hash(plain, this.cost);
  }

  verify(plain: string, hash: string) {
    return bcrypt.compare(plain, hash);
  }
}
