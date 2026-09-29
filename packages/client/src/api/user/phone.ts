/** The account's phone number: text a code, verify it, remove it. Each updates `me`. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSendPhoneCodeMutation() {
  const { api } = useApi();
  return useMutation(api.user.sendPhoneCode.mutationOptions());
}

export function useVerifyPhoneMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.user.verifyPhone.mutationOptions({
      onSuccess: (me) => queryClient.setQueryData(api.user.me.queryKey(), me),
    }),
  );
}

export function useRemovePhoneMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.user.removePhone.mutationOptions({
      onSuccess: (me) => queryClient.setQueryData(api.user.me.queryKey(), me),
    }),
  );
}
