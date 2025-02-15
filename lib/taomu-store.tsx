import React from 'react'

export type Listener = () => void

export interface DispatchOptions<S> {
  /** 是否检查状态变化, actions 中的函数反回值不进验 */
  check?: boolean
  /** 更新完成后的回调, 传入更新后的状态 */
  onChanged?: (state: S) => void
}

export type StoreActions<T extends object = object> = {
  [K in keyof T]?: (data: T[K], states: T) => Record<K, T[K]> & Partial<T>
}

/**
 * ### 基于 React.useSyncExternalStore 实现的全局状态管理器
 *
 * 需要 React 版本 >= 18
 *
 * 高性能状态管理器，派发更新后，仅订阅数据的组件 (组件本身及传递了订阅数据的子组件) 会触发重渲染
 *
 * - store.useStore 订阅数据
 * - store.dispatch 派发更新
 * - actions 可对数据进行处理
 * - options.check 自动检查状态变化
 * - 可以创建多个 Store
 * - 当前渲染线程内跨实例运行
 */
export class Store<StateT extends object> {
  constructor(
    /** 初始化 state */
    private state: StateT,
    /** dispatch 时对数据进行处理 */
    private actions?: StoreActions<StateT>
  ) {}

  public readonly defaultDispatchOptions: DispatchOptions<StateT> = {
    check: false,
  }

  /** 订阅列表 */
  private readonly listeners = new Map<keyof StateT, Set<Listener>>()

  /** 派发批次 */
  private dispatchBatch = 0
  /** 异步派发暂存数据 */
  private dispatchBatchOptionsMap = new Map<number, DispatchOptions<StateT>>()

  /**
   * 是否手动调用触发器
   *
   * - 为 true 时，不会调用 listeners 触发器，转为外部接管
   * - 用于在跨线程通信时，处理异步更新
   */
  public takeOverDispatch = false

  /**
   * 自定义派发前的检查
   *
   * @param dispatchBatch 派发批次
   * @param nextState 下一个状态
   * @param options
   *
   * @returns 返回 false 可阻止状态更新
   */
  public beforeDispatch?: (
    dispatchBatch: number,
    nextState: Partial<StateT>,
    options?: DispatchOptions<StateT>
  ) => boolean | Partial<StateT>

  /**
   * 自定义派发后的回调
   *
   * @param changeState 变更的数据
   */
  public afterDispatch?: (changeState: Record<string, any>) => void

  /** 订阅状态 */
  private readonly subscribe = (listener: Listener, key: keyof StateT) => {
    const listeners = this.listeners.get(key) || new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)

    return () => listeners.delete(listener)
  }

  /**
   * 获取 state
   *
   * @example const state1 = store.getState('state1')
   */
  public getState<K extends keyof StateT>(key: K): StateT[typeof key]
  public getState(key?: keyof StateT): StateT
  public getState(key?: keyof StateT) {
    if (key) {
      return this.state[key]
    } else {
      return this.state
    }
  }

  /**
   * 派发 state 更新
   *
   * @example store.dispatch({ state1: value1, state2: value2 })
   */
  public dispatch(nextState: Partial<StateT>, options?: DispatchOptions<StateT> | ((state: StateT) => void)): void {
    const optionsH: DispatchOptions<StateT> = { ...this.defaultDispatchOptions }
    const changeKeys = Object.keys(nextState) as (keyof StateT)[]
    const changedState: Partial<StateT> = {}

    if (typeof options === 'function') {
      optionsH.onChanged = options
    } else if (options) {
      Object.assign(optionsH, options)
    }

    this.dispatchBatch++

    if (this.beforeDispatch) {
      const res = this.beforeDispatch(this.dispatchBatch, nextState, optionsH)
      if (res === false) return
      if (typeof res === 'object') Object.assign(nextState, res)
    }

    changeKeys.forEach((key) => {
      const nextValue = nextState[key]

      if (typeof this.actions?.[key] === 'function') {
        Object.assign(changedState, this.actions?.[key]?.(nextValue!, this.state))
      } else if (optionsH.check) {
        const currentValue = this.state[key]
        if (nextValue !== currentValue) {
          changedState[key] = nextValue
        }
      } else {
        changedState[key] = nextValue
      }
    })

    this.state = { ...this.state, ...changedState }

    if (this.takeOverDispatch) {
      this.dispatchBatchOptionsMap.set(this.dispatchBatch, optionsH)
    } else {
      this.executeListeners(this.dispatchBatch, changedState, optionsH)
    }
  }

  /**
   * 调用触发器
   *
   * @param dispatchBatch
   * @param changedState
   * @param options
   */
  public executeListeners = (dispatchBatch: number, changedState: Partial<StateT>, options?: DispatchOptions<StateT>) => {
    let optionsH = options

    if (!optionsH) {
      optionsH = this.dispatchBatchOptionsMap.get(dispatchBatch)
      this.dispatchBatchOptionsMap.delete(dispatchBatch)
    }

    for (const realChangeKey in changedState) {
      if (!Object.prototype.hasOwnProperty.call(changedState, realChangeKey)) {
        continue
      }

      const listeners = this.listeners.get(realChangeKey)
      if (listeners) {
        listeners.forEach((listener) => listener())
      } else {
        // console.warn(`${String(key)} has no subscription list`)
        continue
      }
    }

    if (optionsH) {
      optionsH.onChanged?.(this.state)
    } else {
      console.warn(`dispatchBatch<${dispatchBatch}> error: can't find options`)
    }

    this.afterDispatch?.(changedState)
  }

  /**
   * 静态更新 state
   *
   * @param nextState
   */
  public staticUpdateState = (nextState: Partial<StateT>) => {
    Object.assign(this.state, nextState)
  }

  /** Store.dispatch 别名 */
  public readonly setState = this.dispatch

  /**
   * 使用 React.useSyncExternalStore 订阅数据
   *
   * @example const { state1, state2 } = store.useStore(['state1','state2'])
   */
  public readonly useStore = <K extends keyof StateT>(subscribeKeys: K[]) => {
    const res = {} as { [key in K]: StateT[key] }
    subscribeKeys.forEach((key) => {
      if (res[key] !== undefined) return
      // see: https://github.com/reactwg/react-18/discussions/86
      res[key] = React.useSyncExternalStore(
        (listener) => this.subscribe(listener, key),
        () => this.getState(key)
      )
    })

    return res
  }

  /**
   * HOC/装饰器，用于在 class 中订阅数据
   *
   * @param subscribeKeys
   * @returns
   */
  public withStore = <K extends keyof StateT>(subscribeKeys: K[]): any => {
    return (Component: any) => {
      const CompH = (props: any) => {
        const storeStates = this.useStore(subscribeKeys)
        return (
          <div>
            <Component {...props} {...storeStates} />
          </div>
        )
      }

      if (Component.beforeRouter) {
        CompH.beforeRouter = Component.beforeRouter
      }

      return CompH
    }
  }
}
