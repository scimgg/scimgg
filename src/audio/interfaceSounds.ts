/**
 * Sounds the client plays locally from its own interfaces, on a press or a hover rather than on a
 * game event: the third path into `AudioEngine.play`, beside the audio rules and the animation
 * frame sounds. Each is the client's own choice for that interface, cited beside it.
 *
 * They are never tick-aligned and never recorded, so a replay (which shows no interface) plays none.
 */
export const INTERFACE_SOUNDS = {
  /**
   * `interface_select1`: clicking a Fortis Colosseum modifier option, deselecting it included
   * (refs/cs2/scripts/[clientscript,colosseum_intermission_2_mod_button_click].cs2, line 8).
   */
  select: 2266,
  /**
   * `synth_7986`: the pointer entering a Fortis Colosseum modifier option
   * (refs/cs2/scripts/[clientscript,colosseum_intermission_2_mod_button_hover].cs2, line 11).
   * The client has no touch hover, so a touch press never plays it.
   */
  colosseumOptionHover: 7986,
} as const;

export type InterfaceSound = keyof typeof INTERFACE_SOUNDS;

export const INTERFACE_SOUND_IDS: readonly number[] = Object.values(INTERFACE_SOUNDS);

/** What an interface calls to play one; App binds it to the shared engine. */
export type PlayInterfaceSound = (sound: InterfaceSound) => void;
