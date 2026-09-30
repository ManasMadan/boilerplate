import { render, screen } from "@testing-library/react-native";
import { useForm } from "react-hook-form";
import { FormField } from "./form-field";

function Form() {
  // No default value: the field starts empty, not "undefined".
  const form = useForm<{ nickname?: string }>();
  return <FormField control={form.control} name="nickname" label="Nickname" />;
}

describe("FormField", () => {
  it("shows an empty field for a value the form doesn't have yet", async () => {
    await render(<Form />);
    expect(screen.getByLabelText("Nickname")).toHaveDisplayValue("");
  });
});
