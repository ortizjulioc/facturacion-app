import { InvitationView } from "./invitation-view";

// Ver el comentario de /login: sin <Suspense> para que la vista hidrate de inmediato.
export const instant = false;

export default async function Page({ params }: PageProps<"/invitacion/[id]">) {
  const { id } = await params;
  return <InvitationView id={id} />;
}
