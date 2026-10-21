import type { PosState } from "../../shared/api";
import { Modal, SignInForm } from "./ui";

/** Reconectar cuando la sesión con la nube se perdió (la caja sigue vendiendo mientras tanto). */
export function ReconnectModal({ state, onClose, onDone }: { state: PosState; onClose: () => void; onDone: () => void }) {
  return (
    <Modal title="Iniciar sesión" onClose={onClose}>
      <p className="muted">Tus ventas y datos están a salvo en esta caja. Inicia sesión para sincronizarlos.</p>
      <SignInForm
        serverUrl={state.serverUrl ?? ""}
        email={state.user?.email ?? ""}
        lockServer
        submitLabel="Iniciar sesión"
        onSignedIn={async () => {
          await window.pos.sync().catch(() => undefined);
          onDone();
          onClose();
        }}
      />
    </Modal>
  );
}
