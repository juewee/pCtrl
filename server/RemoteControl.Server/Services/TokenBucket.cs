namespace RemoteControl.Server.Services;

/// <summary>令牌桶限流（用于触摸板等高频消息）</summary>
public class TokenBucket
{
    private readonly double _capacity;
    private readonly double _ratePerSecond;
    private double _tokens;
    private long _lastTicks;

    public TokenBucket(double capacity, double ratePerSecond)
    {
        _capacity = capacity;
        _ratePerSecond = ratePerSecond;
        _tokens = capacity;
        _lastTicks = DateTime.UtcNow.Ticks;
    }

    public bool Allow()
    {
        lock (this)
        {
            var now = DateTime.UtcNow.Ticks;
            var elapsed = (now - _lastTicks) / (double)TimeSpan.TicksPerSecond;
            _lastTicks = now;
            _tokens = Math.Min(_capacity, _tokens + elapsed * _ratePerSecond);
            if (_tokens >= 1)
            {
                _tokens -= 1;
                return true;
            }
            return false;
        }
    }
}
