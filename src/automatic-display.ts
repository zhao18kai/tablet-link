export function manageAutomaticDisplay<Display>(
  open: () => Promise<Display>, close: (display: Display) => Promise<void>,
) {
  let owned: { viewer: string; display: Display } | undefined
  let operations: Promise<unknown> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>) {
    const result = operations.then(operation)
    operations = result.catch(() => undefined)
    return result
  }

  async function releaseOwned() {
    if (!owned) return
    const { display } = owned
    owned = undefined
    await close(display)
  }

  return {
    acquire(viewer: string, approved: () => boolean) {
      return enqueue(async () => {
        if (!approved()) return undefined
        if (owned?.viewer === viewer) return owned.display
        await releaseOwned()
        if (!approved()) return undefined
        const display = await open()
        if (!approved()) {
          await close(display)
          return undefined
        }
        owned = { viewer, display }
        return display
      })
    },
    release(viewer?: string, after?: Promise<void>) {
      return enqueue(async () => {
        if (viewer !== undefined && owned?.viewer !== viewer) return
        await after
        await releaseOwned()
      })
    },
  }
}
