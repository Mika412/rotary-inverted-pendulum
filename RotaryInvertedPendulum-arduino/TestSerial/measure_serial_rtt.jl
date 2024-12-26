using Dates
using LibSerialPort

# Function to measure RTT for a single trial
function measure_single_rtt(port, test_byte::UInt8)
    t_start = now()
    LibSerialPort.write(port, [test_byte]) # Send test byte

    received_byte = UInt8(0)
    timeout_seconds = 1
    t_timeout = now() + Second(timeout_seconds)

    # Wait for response
    while now() < t_timeout
        if LibSerialPort.bytesavailable(port) > 0
            received_byte = LibSerialPort.read(port, UInt8)
            break
        end
    end
    t_end = now()

    return received_byte == test_byte ? Millisecond(t_end - t_start).value : nothing
end

# Function to measure RTT over multiple trials
function measure_rtt(serial_port::String, baud_rate::Int; trials::Int=10, test_byte::UInt8=0x55)
    println("Testing with baud rate: $baud_rate...")

    # Open the serial port
    port = LibSerialPort.open(serial_port, baud_rate; parity=LibSerialPort.SP_PARITY_NONE)
    LibSerialPort.set_flow_control(port)
    sleep(1) # Allow time for the port to stabilize
    LibSerialPort.sp_flush(port, LibSerialPort.SP_BUF_BOTH)

    rtt_times = Float64[]
    for i in 1:trials
        rtt = measure_single_rtt(port, test_byte)
        if rtt !== nothing
            push!(rtt_times, rtt)
        else
            println("Warning: No response received on trial $i")
        end
    end

    LibSerialPort.close(port) # Close port

    # Analyze results
    if !isempty(rtt_times)
        println("Results for baud rate $baud_rate:")
        println("  Min RTT: $(minimum(rtt_times)) ms")
        println("  Max RTT: $(maximum(rtt_times)) ms")
        println("  Avg RTT: $(sum(rtt_times) / length(rtt_times)) ms")
    else
        println("No valid RTT measurements for baud rate $baud_rate!")
    end
end

# CLI entrypoint to parse command line arguments
if !isinteractive()
    if length(ARGS) < 2
        println("Usage: julia --project=. ./scripts/measure_serial_rtt.jl <serial_port> <baud_rate>")
        println("Example: julia --project=. ./scripts/measure_serial_rtt.jl /dev/cu.usbserial-110 115200")
        return
    end

    # Parse CLI arguments
    serial_port = ARGS[1]            # 1st argument: serial port
    baud_rate = parse(Int, ARGS[2])  # 2nd argument: baud rate
    trials = 100                     # Number of RTT trials

    # Run RTT test
    measure_rtt(serial_port, baud_rate; trials=trials, test_byte=0x55)
end
