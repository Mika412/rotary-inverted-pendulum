import Electron
import MeshCat
import MeshCatMechanisms
import RigidBodyDynamics as RBD

using LibSerialPort
using Statistics
using RotaryInvertedPendulum

# Define the serial port and baud rate
serial_port = "/dev/cu.usbserial-110"  # Replace with your serial port
baud_rate = 2000000

# Command bytes
const CMD_READY = UInt8(0x01)
const CMD_GET_STATE = UInt8(0x02)
const CMD_SET_TARGET = UInt8(0x03)
const CMD_ENGAGE_MOTOR = UInt8(0x04)
const CMD_DISENGAGE_MOTOR = UInt8(0x05)

# Function to check if the Arduino is ready
function check_arduino_ready(port; retries=3, timeout_seconds=1)
    for attempt in 1:retries
        println("Checking if Arduino is ready... (Attempt $attempt/$retries)")
        LibSerialPort.write(port, [CMD_READY])
        LibSerialPort.flush(port, LibSerialPort.SP_BUF_BOTH)

        response = UInt8[]
        t_timeout = time_ns() + timeout_seconds * 1e9

        while time_ns() < t_timeout
            if LibSerialPort.bytesavailable(port) > 0
                push!(response, LibSerialPort.read(port, UInt8))
                break
            end
        end

        if length(response) == 1 && response[1] == CMD_READY
            println("Arduino is ready!")
            return true
        else
            println("No valid response. Retrying...")
        end

        sleep(0.5)
    end
    println("Failed to get a valid response after $retries attempts.")
    return false
end

# Function to retrieve state from Arduino
function get_pendulum_state(port)
    LibSerialPort.write(port, [CMD_GET_STATE])  # Send command
    # LibSerialPort.sp_blocking_write(port.ref, [CMD_GET_STATE], 500)  # Send command
    state_data = zeros(UInt8, 12)               # Expect 12 bytes of data (4 + 4 + 4)
    nbytes = LibSerialPort.sp_blocking_read(port.ref, Ref(state_data, 1), 12, 500)  # Read 12 bytes with timeout

    if nbytes == 12
        current_time = reinterpret(Int32, state_data[1:4])[1]  # Microseconds
        motor_position = reinterpret(Float32, state_data[5:8])[1]  # Motor position in radians
        pendulum_position = reinterpret(Float32, state_data[9:12])[1]  # Pendulum position in radians
        return current_time, motor_position, pendulum_position
    else
        println("Error: Expected 12 bytes, but received $nbytes bytes.")
        return nothing
    end
end

# Function to set the motor target position (in radians)
function set_motor_target(port, target_position::Float32)
    # Convert target_position to an array of bytes
    target_bytes = reinterpret(UInt8, [target_position])
    @assert length(target_bytes) == 4
    # Send the command and the target position bytes
    LibSerialPort.write(port, [CMD_SET_TARGET; target_bytes])
    # LibSerialPort.sp_blocking_write(port.ref, [CMD_SET_TARGET; target_bytes], 500)
end

# Function to engage the motor
function engage_motor(port)
    LibSerialPort.write(port, [CMD_ENGAGE_MOTOR])
end

# Function to disengage the motor
function disengage_motor(port)
    LibSerialPort.write(port, [CMD_DISENGAGE_MOTOR])
end

# Main function to interact with the Arduino
function main(; visualise=false)
    visualise && @info "Visualising flag has been set to true. Opening visualiser..."

    if visualise
        app = Electron.Application()
        vis = MeshCat.Visualizer()
        open(vis, app)

        MeshCat.setprop!(vis["/Cameras/default/rotated/<object>"], "fov", 40)

        package_path = joinpath(pkgdir(RotaryInvertedPendulum), "..")
        filename = joinpath(package_path, "urdf/model.urdf")
        mechanism = RBD.parse_urdf(filename)

        state = RBD.MechanismState(mechanism)
        urdfvisuals = MeshCatMechanisms.URDFVisuals(filename, package_path=[package_path])
        mvis = MeshCatMechanisms.MechanismVisualizer(state.mechanism, urdfvisuals, vis["model"])

        last_vis_update_time = time_ns()
    end

    port = LibSerialPort.open(serial_port, baud_rate; parity=LibSerialPort.SP_PARITY_NONE)
    LibSerialPort.set_flow_control(port)

    sleep(1)  # Allow time for Arduino to initialize

    if !check_arduino_ready(port)
        println("Error: Arduino not ready. Exiting.")
        LibSerialPort.close(port)
        return
    end

    println("Engaging motor...")
    engage_motor(port)

    println("Starting data retrieval and control loop...")

    start_time = time_ns()
    loop_duration_s = 120  # in seconds
    loop_duration_ns = loop_duration_s * 1e9
    iteration_times = Float64[]
    last_frequency_time = time_ns()

    rate_stats_print = 0.5 * 1e9  # every 0.5 seconds in nanoseconds
    first_loop = true
    initial_arduino_time = 0

    vis_fps = 60  # frames per second of the visualisation
    vis_update_interval = 1 / vis_fps  # in seconds
    vis_update_interval_ns = vis_update_interval * 1e9

    while time_ns() - start_time < loop_duration_ns
        iteration_start_time = time_ns()

        state = get_pendulum_state(port)
        if state !== nothing
            current_time, motor_position, pendulum_position = state

            if first_loop
                initial_arduino_time = current_time
                first_loop = false
            end

            # Update visualization only if sufficient time has passed
            if visualise && (iteration_start_time - last_vis_update_time) >= vis_update_interval_ns
                q = [motor_position, pendulum_position]
                RBD.set_configuration!(mvis, q)
                last_vis_update_time = iteration_start_time
            end

            # Compute target position
            𝐴 = 45  # Amplitude of the sine wave (degrees)
            𝑓 = 1.0  # Frequency of the sine wave (Hz)
            𝑡 = (current_time - initial_arduino_time) / 1e6  # Convert elapsed time from microseconds to seconds
            target_position = deg2rad(𝐴) * sin(2π * 𝑓 * 𝑡)  # Sine wave

            # Send target position to motor
            set_motor_target(port, Float32(target_position))

            # println("Time: $(current_time) µs, Motor: $(motor_position) rad, Pendulum: $(pendulum_position) rad, Target: $(target_position) rad")
        end

        iteration_duration = (time_ns() - iteration_start_time) / 1e9  # Duration in seconds
        push!(iteration_times, iteration_duration)

        if time_ns() - last_frequency_time >= rate_stats_print
            if !isempty(iteration_times)
                avg_freq = 1 / mean(iteration_times)
                println("Average loop frequency: $(round(avg_freq, digits=2)) Hz")
                empty!(iteration_times)  # Reset for next calculation
            end
            last_frequency_time = time_ns()
        end
    end

    println("Disengaging motor...")
    disengage_motor(port)

    println("Data retrieval and control complete.")
    LibSerialPort.close(port)

    if visualise
        MeshCat.close(app)
    end
end

# Execute the main function if run directly
if abspath(PROGRAM_FILE) == @__FILE__
    visualise = "--visualise" in ARGS
    main(visualise=visualise)
end
