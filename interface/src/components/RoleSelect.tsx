"use client";

import { Select, createListCollection } from "@ark-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { Portal } from "@ark-ui/react/portal";

export interface RoleOption<T extends string> {
  value: T;
  label: string;
}

/** Ark UI Select styled with the Flexa tokens. */
export default function RoleSelect<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: RoleOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const collection = createListCollection({ items: options });
  return (
    <Select.Root
      collection={collection}
      value={[value]}
      onValueChange={(d) => d.value[0] && onChange(d.value[0] as T)}
      positioning={{ sameWidth: true }}
    >
      <Select.Label className="field-label">{label}</Select.Label>
      <Select.Control>
        <Select.Trigger className="select-trigger">
          <Select.ValueText />
          <Select.Indicator><ChevronDown size={18} strokeWidth={3} /></Select.Indicator>
        </Select.Trigger>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content className="select-content">
            {collection.items.map((item) => (
              <Select.Item key={item.value} item={item} className="select-item">
                <Select.ItemText>{item.label}</Select.ItemText>
                <Select.ItemIndicator><Check size={18} strokeWidth={3} /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
      <Select.HiddenSelect />
    </Select.Root>
  );
}
