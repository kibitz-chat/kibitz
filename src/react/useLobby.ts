import { useEffect, useState } from 'react'
import type { HostOp } from '../core/hostKey'

export type LobbyStatus = 'waiting' | 'admitted' | 'denied' | 'locked' | 'unverified'

/** The overlay states the panel actually draws — 'admitted' is never shown. */
export type LobbyOverlay = 'waiting' | 'denied' | 'locked' | 'unverified'

/** The room seam this hook needs: the joiner-status subscription. Only the online
 *  Room gates entry; the preview and LAN rooms omit `onLobby`, so this stays null. */
export interface LobbyRoom {
  onLobby?(cb: (status: LobbyStatus) => void): void
}

/**
 * Map a raw lobby status to the overlay the panel renders. 'waiting' and 'denied'
 * show the knock overlay; 'admitted' (and the pre-knock null) show nothing — being
 * let in just resumes the normal flow (the core re-announces us), so there's
 * nothing to overlay.
 */
export function lobbyOverlay(status: LobbyStatus | null): LobbyOverlay | null {
  return status === 'waiting' || status === 'denied' || status === 'locked' || status === 'unverified' ? status : null
}

/**
 * The joiner's own knock state, surfaced to the panel. With the host's lobby on, a
 * connecting peer is held ('waiting') until the host admits or refuses ('denied')
 * it; the online Room emits these over the data channel. Returns the overlay state
 * to draw, or null when there's nothing to show (no lobby, admitted, or pre-knock).
 */
export function useLobby(room: LobbyRoom | null): LobbyOverlay | null {
  const [status, setStatus] = useState<LobbyStatus | null>(null)
  useEffect(() => {
    setStatus(null) // a new (or absent) room starts with a clean slate
    if (!room?.onLobby) return
    let live = true
    room.onLobby((s) => live && setStatus(s))
    return () => {
      live = false
    }
  }, [room])
  return lobbyOverlay(status)
}

// --- Host side -------------------------------------------------------------

/** One peer waiting at the door, as the host sees it. */
export interface Knock {
  id: string
  name: string
  avatar: string
}

/** The room seam the HOST UI needs (authority-only ops). The preview and LAN rooms
 *  omit these, so the host bar simply never appears there. */
export interface HostLobbyRoom {
  isAuthority?(): boolean
  isLobby?(): boolean
  setLobby?(on: boolean): void
  onKnocks?(cb: (list: Knock[]) => void): void
  admit?(id: string): void
  deny?(id: string): void
  /** Remove a call member by their media id (host only). */
  remove?(memberId: string): void
  /** Lock / unlock the room (host only) + reset (clear everyone's chat). */
  isLocked?(): boolean
  setLocked?(on: boolean): void
  resetRoom?(): void
}

/** Knocks are only actionable while the lobby is on — gate them so a stale list
 *  can't linger after the host turns the gate back off. */
export function visibleKnocks(lobbyOn: boolean, knocks: readonly Knock[]): readonly Knock[] {
  return lobbyOn ? knocks : []
}

export interface HostLobby {
  /** We're the room authority — the only role that can gate entry. */
  isHost: boolean
  /** The lobby controls are actually available here (online room + host). */
  canGate: boolean
  lobbyOn: boolean
  /** The room is locked — sealed to new members (host-meaningful). */
  locked: boolean
  knocks: readonly Knock[]
  setLobby: (on: boolean) => void
  admit: (id: string) => void
  deny: (id: string) => void
  /** Remove a call member by their media id (host only). */
  remove: (memberId: string) => void
  /** Lock / unlock the room, and reset (clear everyone's chat). Host only. */
  setLocked: (on: boolean) => void
  resetRoom: () => void
}

/**
 * The HOST half of knock-to-admit: whether we're the authority, the lobby on/off
 * setting, and the live waiting list — plus the ops to toggle the gate and admit or
 * deny each knocker. isHost/lobbyOn are read each render (the room bumps a re-render
 * via onChange whenever the role or setting changes); the knock list rides a
 * subscription. Feature-detected, so preview/LAN rooms yield an inert, hostless result.
 */
export function useHostLobby(
  room: HostLobbyRoom | null,
  /** Are WE the verified host? (We proved the room's host key and the roster names us.) Admin powers
   *  attach to this — NOT to being the coordinator. A room with no host committed → always false. */
  isVerifiedHost: boolean,
  /** Send a signed host moderation command (core/hostKey.ts). The coordinator verifies it against the
   *  link-committed host key, so the host can moderate whether or not it's the current coordinator. */
  moderate: (op: HostOp, target?: string) => void,
): HostLobby {
  const [knocks, setKnocks] = useState<Knock[]>([])
  useEffect(() => {
    setKnocks([])
    if (!room?.onKnocks) return
    let live = true
    room.onKnocks((list) => live && setKnocks(list))
    return () => {
      live = false
    }
  }, [room])
  const isHost = isVerifiedHost
  // Read off the roster — visible to the host regardless of whether it's the coordinator.
  const lobbyOn = !!room?.isLobby?.()
  const locked = !!room?.isLocked?.()
  return {
    isHost,
    canGate: isHost,
    lobbyOn,
    locked,
    knocks: visibleKnocks(lobbyOn, knocks),
    setLobby: (on) => moderate(on ? 'lobbyon' : 'lobbyoff'),
    admit: (id) => moderate('admit', id),
    deny: (id) => moderate('deny', id),
    remove: (memberId) => moderate('kick', memberId),
    setLocked: (on) => moderate(on ? 'lock' : 'unlock'),
    resetRoom: () => moderate('reset'),
  }
}
