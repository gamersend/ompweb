import { DeviceLockGateForm } from "@/components/DeviceLockGateForm";

// Unlock screen for the OPTIONAL device-local passkey gate. Reachable without
// an unlock cookie (the proxy gate exempts /device-lock); the proxy redirects
// page navigations here when OMP_WEB_DEVICE_LOCK=1 and the gate is armed.
export default function DeviceLockPage() {
  return <DeviceLockGateForm />;
}
