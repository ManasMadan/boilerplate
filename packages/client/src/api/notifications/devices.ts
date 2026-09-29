/** Devices that receive push: registered on app start (and on opt-in), removed on sign-out. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRegisterDeviceMutation() {
  const { api } = useApi();
  return useMutation(api.notifications.registerDevice.mutationOptions());
}

export function useUnregisterDeviceMutation() {
  const { api } = useApi();
  return useMutation(api.notifications.unregisterDevice.mutationOptions());
}
