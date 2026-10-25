// Keep the existing acceptance entry point. Since 0.4.2 the gateway owns
// fresh attachment and DA2 negotiation, so legacy replay is no longer exposed
// through its public socket. The historical failure is recorded in revision08.
import './check-terminal-negotiation.mjs';
