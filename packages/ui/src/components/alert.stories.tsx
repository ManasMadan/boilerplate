import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircleAlert, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./alert";

const meta = { component: Alert } satisfies Meta<typeof Alert>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Alert className="w-96">
      <Info />
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>Your trial ends in three days.</AlertDescription>
    </Alert>
  ),
};

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="w-96">
      <CircleAlert />
      <AlertTitle>Payment failed</AlertTitle>
      <AlertDescription>Update your card to keep the workspace on Pro.</AlertDescription>
    </Alert>
  ),
};
