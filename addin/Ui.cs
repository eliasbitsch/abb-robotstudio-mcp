using System;
using System.Collections.Generic;
using System.Runtime.ExceptionServices;
using System.Threading;
using ABB.Robotics.RobotStudio.Environment;

namespace RobotStudioBridge
{
    // Runs RobotStudio Station-API work on RobotStudio's UI thread, which that API requires.
    //
    // Two rules this class exists to keep:
    //  1. A request that times out before its work STARTED is cancelled and never runs.
    //     Without that, a save, a simulation start or a target creation that the caller was
    //     told had failed would still happen minutes later, once the UI thread came free.
    //  2. Nothing that completes through the Windows message pump may be waited on from the
    //     UI thread. RobApi's virtual-panel calls do exactly that; blocking the UI thread on
    //     them deadlocks RobotStudio for good. Controller (PC SDK / RobApi) work therefore runs
    //     on the request thread and only Station-API work comes here.
    internal static class Ui
    {
        static SynchronizationContext _context;
        static int _uiThreadId = -1;
        static readonly Queue<Action> IdleQueue = new Queue<Action>();

        public static string Mode { get; private set; } = "not initialized";

        // Called from AddinMain, which RobotStudio runs on its UI thread.
        public static void Init()
        {
            _uiThreadId = Thread.CurrentThread.ManagedThreadId;
            _context = SynchronizationContext.Current;
            if (_context != null)
            {
                Mode = _context.GetType().Name;
            }
            else
            {
                // Fallback: the Idle event runs on the UI thread whenever its queue drains.
                UIEnvironment.Idle += OnIdle;
                Mode = "UIEnvironment.Idle";
            }
        }

        static void OnIdle(object sender, EventArgs e)
        {
            while (true)
            {
                Action action;
                lock (IdleQueue)
                {
                    if (IdleQueue.Count == 0) return;
                    action = IdleQueue.Dequeue();
                }
                action();
            }
        }

        public static T Invoke<T>(Func<T> func, int startTimeoutMs = 20000, int runTimeoutMs = 120000)
        {
            if (Thread.CurrentThread.ManagedThreadId == _uiThreadId)
                return func();

            var item = new WorkItem<T>(func);
            if (_context != null)
                _context.Post(_ => item.Run(), null);
            else
                lock (IdleQueue) IdleQueue.Enqueue(item.Run);

            if (!item.Started.Wait(startTimeoutMs) && item.TryCancel())
                throw new ApiException(503, "ui_busy",
                    $"RobotStudio's UI thread did not pick the request up within {startTimeoutMs / 1000.0:0.#} s " +
                    "(a modal dialog may be open in RobotStudio). The request was cancelled and will not run later.");

            if (!item.Done.Wait(runTimeoutMs))
                throw new ApiException(504, "ui_timeout",
                    $"The operation started on RobotStudio's UI thread but had not finished after {runTimeoutMs / 1000} s. " +
                    "It is still running and may complete later.");

            if (item.Error != null)
                ExceptionDispatchInfo.Capture(item.Error).Throw();
            return item.Result;
        }

        public static void Invoke(Action action, int startTimeoutMs = 20000, int runTimeoutMs = 120000) =>
            Invoke<object>(() => { action(); return null; }, startTimeoutMs, runTimeoutMs);

        sealed class WorkItem<T>
        {
            readonly Func<T> _func;
            readonly object _lock = new object();
            bool _started, _cancelled;

            public readonly ManualResetEventSlim Started = new ManualResetEventSlim(false);
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
            public T Result;
            public Exception Error;

            public WorkItem(Func<T> func) { _func = func; }

            public void Run()
            {
                lock (_lock)
                {
                    if (_cancelled) return;
                    _started = true;
                }
                Started.Set();
                try { Result = _func(); }
                catch (Exception ex) { Error = ex; }
                finally { Done.Set(); }
            }

            public bool TryCancel()
            {
                lock (_lock)
                {
                    if (_started) return false;
                    _cancelled = true;
                    return true;
                }
            }
        }
    }
}
