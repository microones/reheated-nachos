// Crea un usuari amb una contrasenya aleatòria que haurà de canviar en entrar per primer cop.
// Ús (al servidor):  bun run crea-usuari.ts [--admin] correu@exemple.cat "Nom"
import { createUserWithTempPassword, db } from "./auth";

const args = process.argv.slice(2);
const isAdmin = args[0] === "--admin";
const [email = "", ...nameParts] = isAdmin ? args.slice(1) : args;

try {
  const { user, password } = await createUserWithTempPassword(email, nameParts.join(" "), isAdmin);
  console.log(`Usuari creat: ${user.email} (${user.name})${isAdmin ? " · admin" : ""}`);
  console.log(`Contrasenya provisional: ${password}`);
  console.log("Haurà de triar-ne una de nova en entrar per primer cop. Aquesta contrasenya no es tornarà a mostrar.");
} catch (e) {
  console.error((e as Error).message);
  console.error('Ús: bun run crea-usuari.ts [--admin] correu@exemple.cat "Nom"');
  process.exitCode = 1;
} finally {
  db.close();
}
