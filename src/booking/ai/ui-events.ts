// UI events the booking tools emit to the widget (as SSE `booking_ui` events), so it can render real
// cards and buttons instead of the model typing out times. The model only ever sees compact text.
export interface SlotChoice {
  /** ISO instant — what the widget sends back when the visitor taps it. */
  start: string;
  dayLabel: string;
  timeLabel: string;
}

export type BookingUiEvent =
  | { kind: 'types'; types: Array<{ id: string; name: string; durationMin: number; description?: string | null; priceText?: string | null }> }
  | {
      kind: 'slots';
      typeId: string; typeName: string; durationMin: number;
      timezone: string; tzLabel: string;
      slots: SlotChoice[];
      /** Visitor-local `YYYY-MM-DD` to continue browsing from ("More times"). */
      moreFrom: string | null;
    }
  | {
      kind: 'confirm';
      typeName: string; when: string; durationMin: number; tzLabel: string;
      name: string; email: string; phone?: string | null; where?: string | null; price?: string | null;
      needsApproval: boolean;
    }
  | {
      kind: 'booked';
      status: 'confirmed' | 'pending';
      typeName: string; when: string; durationMin: number; tzLabel: string; email: string; where?: string | null;
      manageUrl: string; googleUrl: string; outlookUrl: string; icsUrl: string;
    };

export type EmitUi = (event: BookingUiEvent) => void;
